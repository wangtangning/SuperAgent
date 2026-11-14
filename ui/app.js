'use strict';
/* SuperAgent 指挥台 — 前端（无框架：宿主快照 + bundle 的 /orchestrator/api） */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;        // 宿主快照
let gh = null;           // GitHub 侧状态
let page = 'overview';
let settingsData = null;
let repoDirty = false;   // 仓库输入框有未保存的手动编辑

const PAGE_META = {
  overview: ['概览', '值守单元、组件健康、最近决策'],
  threads: ['会话', '人和 agent 的同一个入口'],
  tickets: ['工单', '每个工单一个执行器、一个目录、一份产出'],
  evolution: ['进化', '从运行经验里学习：提案 → 应用 → 试用 → 保留/回滚'],
  connect: ['接入', 'GitHub：环境 → agent 账号 → 仓库 → 授权人 → 协作者 → 自检'],
  guide: ['指南', '刚下载？五分钟跑通：账号 → 接入 → 派活 → 进化'],
  settings: ['设置', '执行器、宿主路径与日志'],
  ssh: ['密钥', 'SSH 密钥库：存储 → 分配给 agent'],
  servers: ['服务器', '局域网凭据库：IP/用户名/密码 → 分配给 agent 免问使用'],
  engine: ['引擎', 'DeepSeek Harness 原生界面（高级）']
};

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9 5.5v13M15 5.5v13"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M8 5.6 18.5 12 8 18.4V5.6Z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V11h-6.2"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M9 9.5h6M9 13h6M9 16.5h4"/></svg>'
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ───────────────────────── 格式化 ───────────────────────── */

const PHASE = { idle: '未启动', preparing: '准备中', starting: '启动中', running: '运行中', error: '异常' };

const PROBLEM_CN = {
  repositoryUnset: '还没选仓库',
  agentCliUnset: '还没设置 GitHub CLI',
  agentCliMissing: '找不到 GitHub CLI（gh）',
  agentCliSignedOut: 'GitHub CLI 还没登录',
  agentCliNoAccount: 'GitHub CLI 读不到账号',
  repositoryUnreported: '读不到仓库（名字不对或没权限）',
  foreignFile: '状态目录里有别人的文件',
  blockedCommands: '执行器命令白名单有问题',
  directoryMissing: '工作目录不存在'
};
const problemText = (p) => (p && (PROBLEM_CN[p.code] || p.detail || p.code)) || '';

const DETAIL_CN = {
  'Waiting for the deployment check': '等待部署自检',
  'Nothing waiting': '空闲',
  'No unavailable Eval in the last hour': '近一小时没有判定失败',
  'Orchestrator is ready': '编排就绪'
};
const detailText = (s) => DETAIL_CN[s] || s || '';

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function uptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const STAGE_LABEL = {
  running: ['执行中', 'run'], eval: ['判定中', 'run'], queued: ['排队', 'run'],
  person: ['等人', 'person'], done: ['完成', 'done'], failed: ['失败', 'fail'],
  blocked: ['阻塞', 'fail'], waiting: ['等待', 'run'], review: ['评审', 'run'],
  delivery: ['交付', 'run'], ended: ['结束', 'done'], open: ['进行中', 'run']
};
function stagePill(t) {
  const st = String(t.stage || '').toLowerCase();
  const pair = STAGE_LABEL[st] || [t.stage || t.state || '—', ''];
  return `<span class="stage-pill ${pair[1]}">${esc(pair[0])}</span>`;
}

/* ───────────────────────── 导航 ───────────────────────── */

function setPage(next) {
  page = next;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === next));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === next));
  const meta = PAGE_META[next] || ['', ''];
  $('page-title').textContent = meta[0];
  $('page-sub').textContent = meta[1];
  $('scroll').scrollTop = 0;
  if (next === 'engine' && state && state.url) loadEngine(state.url);
  if (next === 'threads') { refreshThreads(); if (!currentThread) updateComposer(null); }
  if (next === 'tickets') refreshTickets();
  if (next === 'evolution') refreshEvolution();
  if (next === 'connect') refreshGithub();
  if (next === 'settings') loadSettingsBlock();
  if (next === 'ssh') refreshSsh();
  if (next === 'servers') refreshServers();
}

/* ───────────────────────── 项目框架 ───────────────────────── */

let projectsData = null;

async function refreshProjects() {
  try { projectsData = await host.projectsList(); renderProjects(projectsData); } catch {}
}

function renderProjects(d) {
  if (!d) return;
  projectsData = d;
  const active = d.projects.find((p) => p.id === d.activeId);
  $('proj-switch-name').textContent = active ? active.name : '项目';
  $('proj-switch-menu').innerHTML = d.projects.map((p) => `
    <button class="proj-switch-item ${p.id === d.activeId ? 'on' : ''}" data-proj-switch="${esc(p.id)}">
      <b>${esc(p.name)}</b>
      <span>${esc(p.repo || '本地项目')} · :${p.port}</span>
      ${p.id === d.activeId ? '<i>当前</i>' : ''}
    </button>`).join('');
  const grid = $('proj-grid');
  grid.innerHTML = d.projects.map((p) => `
    <div class="proj-card ${p.id === d.activeId ? 'on' : ''}" data-proj="${esc(p.id)}">
      <div class="proj-head"><b>${esc(p.name)}</b>${p.id === d.activeId ? '<span class="stage-pill run">当前</span>' : ''}</div>
      <div class="proj-sub mono">${esc(p.repo || '本地项目')}</div>
      <div class="proj-sub">${esc(p.folder || '')}</div>
      <div class="proj-foot">
        <span class="dot ${p.running ? 'ok' : ''}"></span><span>${p.running ? '引擎运行中' : '未运行'}</span>
        ${p.id !== d.activeId ? '<button class="btn ghost sm" data-proj-switch="' + esc(p.id) + '">切换</button>' : ''}
        ${!p.running ? '<button class="btn ghost sm" data-proj-start="' + esc(p.id) + '">启动</button>' : ''}
      </div>
    </div>`).join('');
}

async function doSwitchProject(id) {
  $('proj-switch-menu').hidden = true;
  try {
    const r = await host.projectsSwitch(id);
    if (!r.ok) throw new Error(r.error || '切换失败');
    settingsData = null; settingsLoaded = false;
    renderHost(await host.get());
    await refreshProjects();
    if (page === 'threads') refreshThreads();
    if (page === 'tickets') refreshTickets();
    if (page === 'evolution') refreshEvolution();
    if (page === 'overview') refreshOverview();
  } catch (e) { toast(e.message); }
}

/* ───────────────────────── 宿主状态 ───────────────────────── */

function renderHost(s) {
  state = s;
  const running = s.phase === 'running';
  const busy = s.phase === 'starting' || s.phase === 'preparing';

  $('rail-dot').className = 'dot ' + (running ? 'ok' : busy ? 'warn' : s.phase === 'error' ? 'bad' : '');
  $('rail-phase').textContent = PHASE[s.phase] || s.phase;
  $('rail-sub').textContent = running && s.startedAt ? `已运行 ${uptime(Date.now() - s.startedAt)}` : 'dsh · superagent';
  $('btn-run').textContent = running ? '停止值守' : busy ? '启动中…' : '启动值守';
  $('btn-run').disabled = busy;
  $('btn-start-engine').disabled = busy;

  const live = $('chip-live');
  live.className = 'chip live ' + (running ? 'ok' : busy ? 'warn' : s.phase === 'error' ? 'bad' : '');
  live.querySelector('span').textContent = PHASE[s.phase] || s.phase;

  const repo = (s.config && s.config.repository) || '';
  $('chip-repo').textContent = repo || '未连接仓库';

  const st = s.state || {};
  const load = st.load || {};
  $('fig-run').textContent = load.maxWorkers ? `${load.running || 0}/${load.maxWorkers}` : '—';
  $('fig-queue').textContent = load.queued == null ? '0' : load.queued;

  const health = st.health || {};
  const names = Object.keys(health);
  const ready = names.filter((n) => health[n].state === 'ready').length;
  $('fig-health').textContent = names.length ? `${ready}/${names.length}` : '—';

  $('btn-pause').innerHTML = st.paused ? ICONS.play : ICONS.pause;
  $('btn-pause').title = st.paused ? '恢复处理' : '暂停处理';
  $('btn-pause').disabled = !running;
  $('btn-restart').innerHTML = ICONS.restart;
  $('btn-restart').disabled = !running;
  $('btn-log').innerHTML = ICONS.log;

  // hero
  const problem = st.setup && st.setup.problem;
  let title = '待启动';
  let sub = '点左下「启动值守」，宿主会准备 profile、装载 bundle，然后拉起 dsh。';
  if (s.phase === 'error') { title = '宿主异常'; sub = s.error || '查看设置页的日志。'; }
  else if (busy) { title = s.phase === 'preparing' ? '正在准备环境…' : '正在拉起 dsh…'; sub = '首次启动会安装 bundle，可能要一两分钟。'; }
  else if (running && problem) { title = '跑起来了，但还缺一步'; sub = `${problemText(problem)}（${problem.place}）`; }
  else if (running) { title = '值守运行中'; sub = '在 GitHub 议题里 @ 它，或直接在「会话」里回它。'; }
  $('hero-title').textContent = title;
  $('hero-sub').textContent = sub;

  // banner：只在宿主异常时出现，缺配置由 hero 说明，避免同一句话说两遍
  const banner = $('setup-banner');
  if (s.phase === 'error' && s.error) {
    banner.hidden = false;
    banner.className = 'banner';
    $('banner-title').textContent = '宿主异常';
    $('banner-detail').textContent = s.error;
    $('banner-go').hidden = true;
  } else {
    banner.hidden = true;
  }

  // health
  $('health-at').textContent = names.length ? `更新于 ${hhmm(Date.now())}` : '';
  $('health').innerHTML = names.length
    ? names.map((n) => {
      const h = health[n] || {};
      return `<div class="h-row"><span class="h-name">${esc(n)}</span><span class="h-state ${esc(h.state || '')}">${esc(h.state || '—')}</span><span class="h-detail" title="${esc(detailText(h.detail))}">${esc(detailText(h.detail))}${h.code ? ` · ${esc(h.code)}` : ''}</span></div>`;
    }).join('')
    : '<div class="empty bare"><span>启动后显示 runtime / github / executor 等组件状态</span></div>';

  // settings 页静态字段
  $('s-port').textContent = s.port;
  $('s-home').textContent = s.dshHome;
  $('s-home').title = s.dshHome;
  $('s-profile').textContent = s.profileDir;
  $('s-profile').title = s.profileDir;
  $('s-bundle').textContent = s.bundleInstalled ? '已安装' : '未安装';
  $('s-bundle').className = s.bundleInstalled ? 't-ok' : 't-warn';
  const ghInfo = s.github || {};
  $('s-gh').textContent = ghInfo.installed ? ghInfo.path : '未安装';
  $('s-gh').title = ghInfo.path || '';

  renderGitHub(ghInfo);
  renderLogs(s.logs || []);
  if (s.projects) renderProjects({ activeId: s.project && s.project.id, projects: s.projects });

  if (running) {
    if (page === 'overview') refreshOverview();
    if (!settingsData) loadSettingsBlock();
  }
}

/* ───────────────────────── 概览数据 ───────────────────────── */

let overviewBusy = false;
async function refreshOverview() {
  if (overviewBusy || !state || state.phase !== 'running') return;
  overviewBusy = true;
  try {
    const res = await Promise.all([
      host.api('overview').catch(() => null),
      host.api('decisions?limit=6').catch(() => null),
      host.api('tickets?state=open&limit=6').catch(() => null)
    ]);
    renderFlow(res[0]);
    renderDecisions(res[1]);
    renderTicketsMini(res[2]);
  } finally {
    overviewBusy = false;
  }
}

function renderFlow(ov) {
  const row = $('flow-row');
  if (!ov) { row.innerHTML = ''; return; }
  const f = ov.flow || {};
  const items = [
    ['收到消息', f.received || 0, 'source 侧轮询到的总数'],
    ['触达工单', f.triggers || 0, '进入判定的消息'],
    ['受理', f.accepted || 0, '变成工单的'],
    ['过滤', f.filtered || 0, '被 policy 挡下的']
  ];
  row.innerHTML = items.map((x) => `<div class="stat" title="${esc(x[2])}"><div class="stat-k">${esc(x[0])}</div><div class="stat-v">${x[1]}</div></div>`).join('');
}

function renderDecisions(d) {
  const box = $('decisions');
  const items = (d && d.items) || [];
  if (!items.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有判定记录。有人派活之后，Policy 的取舍会出现在这里。</span></div>';
    return;
  }
  box.innerHTML = items.map((it) => {
    const kind = it.outcome || it.kind || '—';
    const cls = /accept/i.test(kind) ? 'accept' : /ignore/i.test(kind) ? 'ignore' : /ask|need/i.test(kind) ? 'ask' : '';
    const r = it.reason;
    const reason = typeof r === 'string' ? r : (r && (r.text || r.code || r.message)) || it.summary || '';
    return `<div class="dec"><span class="dec-kind ${cls}">${esc(kind)}</span><div class="dec-body"><div class="dec-reason">${esc(String(reason).slice(0, 220))}</div><div class="dec-meta">${esc(String(it.triggerId || it.id || '').slice(0, 22))}${it.at ? ` · ${hhmm(it.at)}` : ''}</div></div></div>`;
  }).join('');
}

function renderTicketsMini(t) {
  const box = $('tickets-mini');
  const items = (t && t.items) || [];
  if (!items.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有工单。授权的人在仓库议题里 @ 它，就会开单。</span></div>';
    return;
  }
  box.innerHTML = items.map((it) => `
    <div class="tk-row" data-ticket="${esc(it.id)}">
      ${stagePill(it)}
      <span class="tk-title">${esc(it.title || it.id)}</span>
      <span class="tk-time">${esc(ago(it.updatedAt))}</span>
    </div>`).join('');
}

/* ───────────────────────── 会话 ───────────────────────── */

let threads = [];
let threadFilter = 'subscribed';
let currentThread = null;
let currentThreadUrl = '';
let threadBusy = false;

async function refreshThreads() {
  if (!state || state.phase !== 'running' || threadBusy) return;
  threadBusy = true;
  try {
    const r = await host.api(`threads?filter=${threadFilter}&limit=50`);
    threads = r.items || [];
    renderThreadList();
    if (currentThread && threads.some((t) => t.key === currentThread)) await openThread(currentThread, true);
  } catch (e) {
    $('thread-items').innerHTML = `<div class="empty sm"><span>${esc(e.message)}</span></div>`;
  } finally {
    threadBusy = false;
  }
}

function renderThreadList() {
  const box = $('thread-items');
  const q = ($('thread-search').value || '').trim().toLowerCase();
  const list = threads.filter((t) => !q || `${t.title} ${t.key}`.toLowerCase().includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="empty sm"><span>${q ? '没有匹配的会话' : '暂无会话'}</span></div>`;
    renderConvoEmpty();
    return;
  }
  box.innerHTML = list.map((t) => {
    const latest = t.latest || {};
    return `<div class="th-item ${t.key === currentThread ? 'on' : ''}" data-thread="${esc(t.key)}">
      <div class="th-top">
        <span class="th-src">${esc(t.source || 'src')}</span>
        <span class="th-title">${esc(t.title || t.key)}</span>
      </div>
      <div class="th-preview">${esc(latest.preview || '—')}</div>
      <div class="th-meta">${esc(latest.actor || '')}${latest.at ? ` · ${esc(ago(latest.at))}` : ''}${t.subscriptions ? ` · ${t.subscriptions} 张工单` : ''}</div>
    </div>`;
  }).join('');
  if (!currentThread) renderConvoEmpty();
}

/** 会话空状态：区分「没接入」和「接入了但还没有会话」，后者给出去仓库开议题的入口。 */
function renderConvoEmpty() {
  const body = $('convo-body');
  const repo = (state && state.config && state.config.repository) || '';
  const connected = !!(gh && gh.login) && !!repo;
  if (connected) {
    body.innerHTML = `<div class="empty">
      <div class="empty-art">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2-1 0-2-.14-2.9-.4L4 20.5l1.5-4.1C4.3 15.2 3.5 13.8 3.5 12.2c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z"/></svg>
      </div>
      <b>已接入，还没有会话</b>
      <span>点「＋ 新任务」直接派活，或在仓库议题里 @ 它；值守收到消息后，会话会出现在这里。</span>
      <button class="btn sm" id="btn-empty-new-issue">＋ 新任务</button>
      <button class="btn ghost sm" id="btn-open-repo-issues">去仓库开议题</button>
    </div>`;
    const b = $('btn-open-repo-issues');
    if (b) b.onclick = () => host.openExternal(`https://github.com/${repo}/issues/new`);
    const nb = $('btn-empty-new-issue');
    if (nb) nb.onclick = openIssueModal;
  } else {
    body.innerHTML = `<div class="empty">
      <div class="empty-art">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2-1 0-2-.14-2.9-.4L4 20.5l1.5-4.1C4.3 15.2 3.5 13.8 3.5 12.2c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2Z"/></svg>
      </div>
      <b>还没有会话</b>
      <span>接入 GitHub 之后，你在议题里 @ 它、它在这里回你——同一个入口。</span>
      <button class="btn ghost sm" data-goto="connect">去接入 GitHub</button>
    </div>`;
  }
  updateComposer(null);
}

async function openThread(key, silent) {
  currentThread = key;
  renderThreadList();
  try {
    const d = await host.api(`threads/${encodeURIComponent(key)}`);
    renderThread(d);
  } catch (e) {
    if (!silent) toast('读取会话失败：' + e.message);
  }
}

function renderThread(d) {
  const head = $('convo-head');
  const url = d.url || '';
  currentThreadUrl = url;
  head.innerHTML = `
    <div style="min-width:0">
      <div class="convo-title">${esc(d.title || d.key)}</div>
      <div class="convo-meta">${esc(d.source || '')} · ${esc(d.stage || '')}${d.subscriptions ? ` · ${d.subscriptions} 张工单` : ''}</div>
    </div>
    ${url ? '<button class="btn ghost sm" id="btn-open-thread" style="margin-left:auto">在浏览器打开</button>' : ''}
    <button class="btn ghost sm" id="btn-thread-requeue" ${d.timeline && d.timeline.length ? '' : 'disabled'}>重新判定最新一条</button>`;
  if (url) $('btn-open-thread').onclick = () => host.openExternal(url);

  const body = $('convo-body');
  const items = (d.timeline || []).slice().reverse();
  if (!items.length) {
    body.innerHTML = '<div class="empty sm"><span>这个会话还没有消息。</span></div>';
  } else {
    body.innerHTML = items.map((m) => {
      const name = (m.actor && (m.actor.name || m.actor.id || m.actor.login)) || (m.human ? '你' : 'agent');
      const initials = String(name).replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 2).toUpperCase() || '·';
      const disp = m.disposition || {};
      const tags = [];
      if (disp.queued) tags.push('<span class="mini-tag">排队判定</span>');
      if (disp.evaluating) tags.push('<span class="mini-tag warn">判定中</span>');
      if (disp.delivered) tags.push('<span class="mini-tag ok">已交给执行器</span>');
      if (disp.filtered) tags.push(`<span class="mini-tag warn">被过滤：${esc(disp.filtered)}</span>`);
      if (disp.fanout && disp.fanout.length) tags.push(`<span class="mini-tag ok">开单 ${disp.fanout.length}</span>`);
      if (disp.decision) tags.push(`<span class="mini-tag">决定：${esc(disp.decision.outcome || '')}</span>`);
      if (m.actions && m.actions.requeue) tags.push('<span class="mini-tag warn">可重判</span>');
      return `<div class="msg ${m.human ? 'human' : ''}">
        <div class="who">${esc(initials)}</div>
        <div class="msg-main">
          <div class="msg-head"><span class="msg-name">${esc(name)}</span><span class="msg-at">${esc(ago(m.at))}</span></div>
          <div class="msg-bubble">${esc(m.text || m.preview || '')}</div>
          ${tags.length ? `<div class="msg-tags">${tags.join('')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    body.scrollTop = body.scrollHeight;
  }

  $('btn-thread-requeue').onclick = async () => {
    const last = (d.timeline || [])[0];
    if (!last) return;
    try { await host.post(`triggers/${encodeURIComponent(last.id)}/requeue`); toast('已送去重新判定'); openThread(d.key); }
    catch (e) { toast('重判失败：' + e.message); }
  };
  updateComposer(d);
}

function updateComposer(d) {
  const ta = $('composer-input');
  const btn = $('btn-send');
  const canSend = !!(d && d.url && /github\.com/i.test(d.url)) && !!state && state.phase === 'running';
  ta.disabled = !canSend;
  btn.disabled = !canSend;
  ta.placeholder = canSend
    ? '回复这个会话…（Enter 发送，Shift+Enter 换行）'
    : d && d.url
      ? '这个会话不在 GitHub 议题上，请到来源里回复。'
      : '先选一个会话；接入 GitHub 之后才能在这里回复。';
}

async function sendMessage() {
  const ta = $('composer-input');
  const text = ta.value.trim();
  if (!text) return;
  const t = threads.find((x) => x.key === currentThread);
  const url = currentThreadUrl || (t && t.url);
  if (!url) return toast('这个会话没有可回复的地址');
  $('btn-send').disabled = true;
  try {
    const r = await host.comment(url, text);
    if (!r.ok) throw new Error(r.error || '发送失败');
    ta.value = '';
    ta.style.height = '';
    toast('已发出');
    setTimeout(() => openThread(currentThread), 800);
  } catch (e) {
    toast('发送失败：' + e.message);
  } finally {
    $('btn-send').disabled = false;
  }
}

/* ───────────────────────── 工单 ───────────────────────── */

let ticketFilter = 'open';
let currentTicket = null;

async function refreshTickets() {
  if (!state || state.phase !== 'running') return;
  try {
    const r = await host.api(`tickets?state=${ticketFilter === 'all' ? 'all' : ticketFilter}&limit=100`);
    const items = r.items || [];
    $('ticket-count').textContent = `${items.length} 张`;
    const box = $('ticket-list');
    if (!items.length) {
      box.innerHTML = '<div class="empty sm"><span>这个筛选下没有工单。</span></div>';
      return;
    }
    box.innerHTML = items.map((it) => `
      <div class="ticket-row ${it.id === currentTicket ? 'on' : ''}" data-ticket="${esc(it.id)}">
        <div class="tk-line1">${stagePill(it)}<span class="tk-title">${esc(it.title || it.id)}</span></div>
        ${it.note ? `<div class="tk-note">${esc(it.note.text || '')}</div>` : ''}
        <div class="tk-sub"><span>${esc(String(it.id).slice(0, 12))}</span><span>${it.assignments || 0} 执行</span><span>${esc(ago(it.updatedAt))}</span></div>
      </div>`).join('');
  } catch (e) {
    $('ticket-list').innerHTML = `<div class="empty sm"><span>${esc(e.message)}</span></div>`;
  }
}

async function openTicket(id) {
  currentTicket = id;
  refreshTickets();
  try {
    const t = await host.api(`tickets/${encodeURIComponent(id)}`);
    const box = $('ticket-detail');
    box.innerHTML = `
      <div class="card-head"><span>工单详情</span><em>${esc(String(t.id).slice(0, 16))}</em></div>
      <div class="detail-title">${esc(t.title || t.id)}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">${stagePill(t)}<span class="convo-meta">${esc(t.stage || '')}${t.action ? ' · ' + esc(t.action) : ''}</span></div>
      ${await personActionHtml(t)}
      <div class="detail-grid">
        <div class="dcard"><div class="k">执行器</div><div class="v">${Array.isArray(t.assignments) ? t.assignments.length : (t.assignments || 0)}</div></div>
        <div class="dcard"><div class="k">输入</div><div class="v">${Array.isArray(t.inputs) ? t.inputs.length : (t.inputs || 0)}</div></div>
        <div class="dcard"><div class="k">强度</div><div class="v">${esc(t.strength || '—')}</div></div>
        <div class="dcard"><div class="k">更新</div><div class="v">${esc(ago(t.updatedAt))}</div></div>
      </div>
      ${t.attention && t.attention.question ? `<div class="detail-summary"><b class="warn">等你回答：</b>\n${esc(t.attention.question)}</div>` : ''}
      ${t.summary ? `<div class="detail-summary" style="margin-top:8px">${esc(t.summary)}</div>` : ''}
      ${t.directory ? `<div class="kv"><span>目录</span><b class="mono ell">${esc(t.directory)}</b></div>` : ''}
      <div class="actions">
        <button class="btn sm ghost" id="tk-retry" ${t.actions && t.actions.retry ? '' : 'disabled'}>重试</button>
        <button class="btn sm danger" id="tk-stop" ${t.actions && t.actions.stop ? '' : 'disabled'}>停止</button>
      </div>`;
    $('tk-retry').onclick = async () => { try { await host.post(`tickets/${encodeURIComponent(id)}/retry`); toast('已重试'); refreshTickets(); } catch (e) { toast(e.message); } };
    $('tk-stop').onclick = async () => { try { await host.post(`tickets/${encodeURIComponent(id)}/stop`); toast('已停止'); refreshTickets(); } catch (e) { toast(e.message); } };
    const prBtn = $('tk-open-pr');
    if (prBtn) prBtn.onclick = () => host.openExternal(prBtn.dataset.url);
    const thBtn = $('tk-open-thread');
    if (thBtn) thBtn.onclick = () => { setPage('threads'); openThread(thBtn.dataset.key); };
  } catch (e) {
    $('ticket-detail').innerHTML = `<div class="empty sm"><span>${esc(e.message)}</span></div>`;
  }
}

/** 「等人」阶段的人话解释 + 下一步动作按钮。 */
async function personActionHtml(t) {
  if (t.stage !== 'person') return '';
  const repo = (state && state.config && state.config.repository) || '';
  const thread = (t.threads || []).find((x) => /\/pull\/\d+/.test(x.url || '')) || (t.threads || [])[0] || {};
  let prUrl = '';
  if (thread.key && /^github:\d+$/.test(thread.key) && repo) {
    const num = thread.key.slice(7);
    try {
      const d = await host.api(`threads/${encodeURIComponent(thread.key)}`);
      const url = d.url || '';
      prUrl = /\/pull\//.test(url) ? url : `https://github.com/${repo}/pull/${num}`;
    } catch { prUrl = `https://github.com/${repo}/pull/${num}`; }
  }
  const threadBtn = thread.key ? `<button class="btn ghost sm" id="tk-open-thread" data-key="${esc(thread.key)}">去会话回复</button>` : '';
  const map = {
    review: {
      text: 'agent 已完成工作并开了 PR，<b>等你评审合并</b>。打开 PR 看改动：没问题就 Merge（工单自动以 merged 结束并汇报）；要修改就在议题里回复它，它会继续改。',
      btn: prUrl ? `<button class="btn sm" id="tk-open-pr" data-url="${esc(prUrl)}">打开 PR 评审</button>` : ''
    },
    answer: {
      text: `agent 有问题等你回答：<b>${esc((t.attention && t.attention.question) || '')}</b> 去会话里回复它。`,
      btn: threadBtn
    },
    blocked: {
      text: 'agent 被卡住了（权限/资源/环境）。看下面的摘要，补齐它需要的东西后点「重试」，或在会话里回复说明。',
      btn: threadBtn
    },
    failed: {
      text: '这一轮执行失败。看摘要找原因；可以直接「重试」，或在会话里补充说明后再试。失败经验会进入进化页。',
      btn: threadBtn
    },
    delivery: {
      text: 'agent 的回复没能送达议题（网络/权限）。检查接入状态后重试。',
      btn: ''
    }
  };
  const m = map[t.action] || { text: '工单在等你处理。去会话看看上下文。', btn: threadBtn };
  return `<div class="person-action"><div class="pa-text">${m.text}</div><div class="pa-btns">${m.btn}${m.btn && threadBtn ? threadBtn : ''}</div></div>`;
}

/* ───────────────────────── 局域网服务器 ───────────────────────── */

let servers = null;

async function refreshServers() {
  try { servers = await host.serversList(); renderServers(servers); } catch (e) { toast(e.message); }
}

function renderServers(s) {
  if (!s) return;
  servers = s;
  $('srv-assigned-note').textContent = s.assignedIds.length ? `已分配 ${s.assignedIds.length} 台给 agent` : '未分配';
  const box = $('srv-list');
  if (!s.servers.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有服务器。填 IP/用户名/密码保存，然后分配给 agent。</span></div>';
    return;
  }
  box.innerHTML = s.servers.map((v) => {
    const on = s.assignedIds.includes(v.id);
    return `<div class="ssh-key ${on ? 'on' : ''}">
      <div class="ssh-key-head">
        <b>${esc(v.name)}</b>
        ${on ? '<span class="stage-pill done">agent 可用</span>' : ''}
        <span class="ssh-fp mono">${esc(v.username)}@${esc(v.host)}:${v.port} · ${v.auth === 'password' ? '密码' : '密钥'}</span>
      </div>
      ${v.note ? `<div class="evo-p-why">${esc(v.note)}</div>` : ''}
      <div class="pa-btns">
        <button class="btn ghost sm" data-srv-act="test" data-srv-id="${esc(v.id)}">测试连接</button>
        ${on
          ? '<button class="btn ghost sm" data-srv-act="unassign" data-srv-id="' + esc(v.id) + '">取消分配</button>'
          : '<button class="btn sm" data-srv-act="assign" data-srv-id="' + esc(v.id) + '">分配给 agent</button>'}
        <button class="btn ghost sm danger" data-srv-act="remove" data-srv-id="${esc(v.id)}">删除</button>
      </div>
      <pre class="logs ssh-test-out" id="srv-out-${esc(v.id)}" hidden></pre>
    </div>`;
  }).join('');
}

async function srvAction(act, id) {
  try {
    if (act === 'test') {
      const out = $('srv-out-' + id);
      out.hidden = false; out.textContent = '连接中…';
      const r = await host.serversTest(id);
      out.textContent = (r.ok ? '✓ 连接成功\n' : '✗ ') + r.output;
      return;
    }
    if (act === 'assign') { toast('分配中，引擎重启注入 lan 助手…'); await host.serversAssign(id); toast('已分配：agent 可用 lan 命令登录'); }
    if (act === 'unassign') { await host.serversUnassign(id); toast('已取消分配'); }
    if (act === 'remove') { await host.serversRemove(id); toast('已删除'); }
    refreshServers();
  } catch (e) { toast(e.message); }
}

/* ───────────────────────── SSH 密钥库 ───────────────────────── */

let ssh = null;

async function refreshSsh() {
  try { ssh = await host.sshList(); renderSsh(ssh); } catch (e) { toast(e.message); }
}

function renderSsh(s) {
  if (!s) return;
  ssh = s;
  const assigned = s.keys.find((k) => k.id === s.assignedId);
  $('ssh-assigned-note').textContent = assigned ? `agent 正在使用：${assigned.name}` : '未分配给 agent';
  const box = $('ssh-list');
  if (!s.keys.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有密钥。生成一把或导入已有私钥，然后分配给 agent。</span></div>';
    return;
  }
  box.innerHTML = s.keys.map((k) => {
    const on = k.id === s.assignedId;
    return `<div class="ssh-key ${on ? 'on' : ''}">
      <div class="ssh-key-head">
        <b>${esc(k.name)}</b>
        ${on ? '<span class="stage-pill done">agent 使用中</span>' : ''}
        <span class="ssh-fp mono">${esc(k.fingerprint || '')}</span>
      </div>
      <div class="ssh-pub mono" title="公钥：贴到 GitHub / 服务器 authorized_keys">${esc(k.publicKey)}</div>
      <div class="pa-btns">
        <button class="btn ghost sm" data-ssh-act="copy" data-ssh-id="${esc(k.id)}">复制公钥</button>
        <button class="btn ghost sm" data-ssh-act="register" data-ssh-id="${esc(k.id)}">登记到 agent GitHub</button>
        ${on
          ? '<button class="btn ghost sm" data-ssh-act="unassign" data-ssh-id="' + esc(k.id) + '">取消分配</button>'
          : '<button class="btn sm" data-ssh-act="assign" data-ssh-id="' + esc(k.id) + '">分配给 agent</button>'}
        <button class="btn ghost sm danger" data-ssh-act="remove" data-ssh-id="${esc(k.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
}

async function sshAction(act, id) {
  const key = ssh && ssh.keys.find((k) => k.id === id);
  try {
    if (act === 'copy') { await navigator.clipboard.writeText(key.publicKey); toast('公钥已复制'); return; }
    if (act === 'register') {
      const r = await host.sshRegisterGithub(id);
      if (r.ok) toast('公钥已登记到 agent 的 GitHub');
      else if (/404|403/.test(r.error || '')) toast('agent 登录授权不含管理公钥权限：请复制公钥，到 agent 账号 Settings → SSH keys 手动添加');
      else toast(r.error);
      return;
    }
    if (act === 'remove') { await host.sshRemove(id); toast('已删除'); }
    if (act === 'assign') { toast('分配中，引擎会重启以注入密钥…'); await host.sshAssign(id); toast('已分配给 agent'); }
    if (act === 'unassign') { await host.sshUnassign(); toast('已取消分配'); }
    refreshSsh();
  } catch (e) { toast(e.message); }
}

/* ───────────────────────── 新任务（会话页直接派活） ───────────────────────── */

function openIssueModal() {
  if (!state || !state.config || !state.config.repository) { toast('先在接入页选一个仓库'); return setPage('connect'); }
  const poster = (gh && gh.posterLogin) || '';
  const agent = (gh && (gh.agentLogin || gh.login)) || '';
  $('issue-as').textContent = poster ? `以 @${poster} 派活给 @${agent}` : '需要发单人登录';
  $('issue-modal').hidden = false;
  $('issue-title').focus();
}

async function submitIssue() {
  const title = $('issue-title').value.trim();
  const body = $('issue-body').value.trim();
  if (!title && !body) return toast('写点要求再派活');
  $('btn-issue-submit').disabled = true;
  try {
    const r = await host.createIssue(title, body);
    if (!r.ok) throw new Error(r.error || '开议题失败');
    $('issue-modal').hidden = true;
    $('issue-title').value = '';
    $('issue-body').value = '';
    toast(`已派活：议题 #${r.number}，值守最多 60s 内接收`);
    setTimeout(() => refreshThreads(), 3000);
  } catch (e) { toast(e.message); }
  finally { $('btn-issue-submit').disabled = false; }
}

/* ───────────────────────── 进化 ───────────────────────── */

let evo = null;
let evoBusy = false;

const EVO_STATUS = {
  proposed: ['待批准', 'warn'], approved: ['已批准', 'warn'], trial: ['试用中', 'run'],
  kept: ['已保留', 'done'], rolled_back: ['已回滚', 'fail'], rejected: ['已驳回', 'fail']
};
const EVO_OUTCOME = { merged: ['已合并', 'done'], completed: ['已完成', 'done'], closed: ['已关闭', 'person'], stopped: ['被停止', 'fail'], dropped: ['被放弃', 'fail'] };

async function refreshEvolution() {
  if (evoBusy) return;
  evoBusy = true;
  try {
    evo = await host.evolutionGet();
    renderEvolution(evo);
  } catch (e) {
    $('evo-sub').textContent = '读取进化状态失败：' + e.message;
  } finally { evoBusy = false; }
}

function pctText(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }

function renderEvolution(s) {
  if (!s) return;
  evo = s;
  const st = s.stats || {};
  $('evo-enabled').checked = !!(s.settings && s.settings.enabled);
  $('evo-autoapply').checked = !!(s.settings && s.settings.autoApply);
  $('evo-last').textContent = s.busy ? '正在进化…' : s.lastTickAt ? `上轮 ${ago(s.lastTickAt)}` : '还没有跑过';
  if (s.lastError) $('evo-last').textContent += ' · 上轮出错';

  const cards = [
    ['经验条目', s.experienceCount || 0, '工单结果 + 决策记录'],
    ['工单样本', st.samples || 0, '已结束的工单'],
    ['成功率', pctText(st.successRate), 'merged / completed 占比'],
    ['重试率', pctText(st.retryRate), '多于一次执行的工单占比'],
    ['平均执行次数', st.avgAttempts == null ? '—' : st.avgAttempts.toFixed(1), '每张工单']
  ];
  $('evo-stats').innerHTML = cards.map((c) => `<div class="stat" title="${esc(c[2])}"><div class="stat-k">${esc(c[0])}</div><div class="stat-v">${esc(String(c[1]))}</div></div>`).join('');

  renderEvoChart(s.metrics || []);
  renderEvoProposals(s.proposals || []);
  renderEvoExperiences(s.recentExperiences || []);
  const logBox = $('evo-log');
  logBox.textContent = (s.log || []).join('\n');
  logBox.scrollTop = logBox.scrollHeight;
}

function renderEvoChart(metrics) {
  const box = $('evo-chart');
  const pts = metrics.filter((m) => m.successRate != null);
  if (pts.length < 2) {
    box.innerHTML = '<div class="empty bare"><span>样本还不够画走势。每轮采集会记一个点，工单结束后曲线就会出现。</span></div>';
    return;
  }
  const W = 560, H = 150, P = 14;
  const xs = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const ys = (v) => H - P - v * (H - 2 * P);
  const line = pts.map((m, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(m.successRate).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(pts.length - 1).toFixed(1)},${H - P} L${xs(0).toFixed(1)},${H - P} Z`;
  const last = pts[pts.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="evo-svg">
    <line x1="${P}" y1="${ys(0.5)}" x2="${W - P}" y2="${ys(0.5)}" class="grid" />
    <path d="${area}" class="area" />
    <path d="${line}" class="line" />
    <circle cx="${xs(pts.length - 1)}" cy="${ys(last.successRate)}" r="3.5" class="pt" />
    <text x="${P}" y="${ys(1) + 4}" class="lbl">100%</text>
    <text x="${P}" y="${ys(0.5) - 4}" class="lbl">50%</text>
  </svg>
  <div class="evo-chart-foot">最新 ${pctText(last.successRate)} · ${pts.length} 个采样点</div>`;
}

function evoProposalActions(p) {
  const btn = (act, label, cls) => `<button class="btn sm ${cls || 'ghost'}" data-evo-act="${act}" data-evo-id="${esc(p.id)}">${label}</button>`;
  if (p.status === 'proposed') return btn('apply', '批准并应用', '') + btn('reject', '驳回');
  if (p.status === 'trial') return btn('evaluate', '立即裁决') + btn('rollback', '回滚', 'danger');
  if (p.status === 'kept') return btn('rollback', '回滚');
  return '';
}

function renderEvoProposals(list) {
  const box = $('evo-proposals');
  $('evo-proposal-count').textContent = list.length ? `${list.length} 张` : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有提案。积累足够的工单结果后，失败聚类会自动变成改进提案。</span></div>';
    return;
  }
  box.innerHTML = list.map((p) => {
    const [label, cls] = EVO_STATUS[p.status] || [p.status, ''];
    const base = p.baseline || {};
    const trial = p.trial || {};
    const compare = p.status === 'kept' || p.status === 'rolled_back'
      ? `<div class="evo-compare">基线成功率 <b>${pctText(base.successRate)}</b>（${base.samples || 0} 单）→ 试用 <b>${pctText(trial.successRate)}</b>（${trial.samples || 0} 单）</div>` : '';
    const trialLive = p.status === 'trial' && p.appliedAt ? `<div class="evo-compare">试用中 · 自 ${esc(ago(p.appliedAt))}起，基线成功率 <b>${pctText(base.successRate)}</b></div>` : '';
    const examples = (p.evidence && p.evidence.examples || []).slice(0, 3)
      .map((x) => `<div class="evo-example">${esc(x.title || x.ticketId || '')}<span>${esc(String(x.summary || '').slice(0, 140))}</span></div>`).join('');
    const hist = (p.history || []).slice(-4).map((h) => `<span class="mini-tag">${esc(hhmm(h.at))} ${esc((EVO_STATUS[h.to] || [h.to])[0])}</span>`).join('');
    return `<div class="evo-p">
      <div class="evo-p-head">
        <span class="stage-pill ${cls}">${esc(label)}</span>
        <b>${esc(p.title)}</b>
        <span class="evo-p-kind">${p.kind === 'prompt' ? '提示词/技能' : '执行参数'}</span>
        <span class="evo-p-time">${esc(ago(p.createdAt))}</span>
      </div>
      <div class="evo-p-why">${esc(p.rationale)}</div>
      ${examples ? `<details class="evo-details"><summary>依据的失败案例</summary>${examples}</details>` : ''}
      ${compare}${trialLive}
      <div class="evo-p-foot">${hist}<span class="sp"></span>${evoProposalActions(p)}</div>
    </div>`;
  }).join('');
}

function renderEvoExperiences(list) {
  const box = $('evo-exp');
  $('evo-exp-count').textContent = evo && evo.experienceCount ? `共 ${evo.experienceCount} 条 · 最近 ${list.length} 条` : '';
  const tickets = list.filter((e) => e.kind === 'ticket');
  if (!tickets.length) {
    box.innerHTML = '<div class="empty bare"><span>还没有运行经验。工单结束（合并/完成/关闭/失败）后会自动记录在这里。</span></div>';
    return;
  }
  box.innerHTML = tickets.map((e) => {
    const [label, cls] = e.outcome ? (EVO_OUTCOME[e.outcome] || [e.outcome, '']) : ['失败', 'fail'];
    return `<div class="evo-e">
      <span class="stage-pill ${cls}">${esc(label)}</span>
      <span class="evo-e-title" title="${esc(e.summary)}">${esc(e.title || e.ticketId)}</span>
      ${e.failureClass ? `<span class="mini-tag warn">${esc(e.failureClass)}</span>` : ''}
      ${e.retried ? `<span class="mini-tag">${e.attempts} 次执行</span>` : ''}
      <span class="evo-e-time">${esc(ago(e.at))}</span>
    </div>`;
  }).join('');
}

async function evoAction(act, id) {
  try {
    if (act === 'apply') { toast('应用中…'); renderEvolution(await host.evolutionApply(id)); toast('已应用，进入试用'); }
    if (act === 'reject') { renderEvolution(await host.evolutionReject(id, '人工驳回')); toast('已驳回'); }
    if (act === 'rollback') { toast('回滚中…'); renderEvolution(await host.evolutionRollback(id, '人工回滚')); toast('已回滚'); }
    if (act === 'evaluate') { renderEvolution(await host.evolutionEvaluate(id)); toast('已裁决'); }
  } catch (e) { toast(e.message); }
}

/* ───────────────────────── GitHub ───────────────────────── */

let ghPollTimer = null;

async function refreshGithub() {
  try {
    gh = await host.ghStatus();
  } catch { gh = (state && state.github) || null; }
  if (gh && state && state.config && state.config.repository && gh.posterLogin) {
    try { gh.collab = await host.collabStatus(); } catch {}
  }
  renderGitHub(gh);
  if (gh && gh.auth && gh.auth.pending && !ghPollTimer) {
    ghPollTimer = setInterval(async () => {
      try {
        const next = await host.ghStatus();
        renderGitHub(next);
        if (!next.auth.pending) { clearInterval(ghPollTimer); ghPollTimer = null; }
      } catch {}
    }, 3000);
  }
}

function renderGitHub(g) {
  if (!g) return;
  gh = g;

  // step 1：环境
  const cliDone = !!g.installed;
  $('cli-state').textContent = cliDone ? g.path : '未找到 gh';
  $('cli-state').className = 'step-state ' + (cliDone ? 'ok' : 'warn');
  $('btn-install-gh').hidden = cliDone;
  $('btn-install-gh').disabled = !!(g.install && g.install.running);
  const err = (g.install && g.install.error) || '';
  $('cli-error').hidden = !err || cliDone;
  $('cli-error').textContent = err;
  const prog = g.install && g.install.running;
  $('gh-progress').hidden = !prog;
  if (prog) {
    $('gh-progress').style.setProperty('--p', (g.install.pct || 0) + '%');
    $('gh-progress-text').textContent = `${g.install.msg || ''} ${g.install.pct || 0}%`;
  }

  // step 2：agent 账号（全局身份，所有项目共用）
  const login = g.agentLogin || '';
  const pending = !!(g.auth && g.auth.pending);
  const authErr = (g.auth && g.auth.error) || '';
  $('login-state').textContent = login ? `已登录 @${login}` : pending ? '等待浏览器授权…' : authErr || '未登录';
  $('login-state').className = 'step-state ' + (login ? 'ok' : pending ? 'warn' : authErr ? 'bad' : '');
  $('device').hidden = !(pending && g.auth.userCode);
  if (pending && g.auth.userCode) $('device-code').textContent = g.auth.userCode;
  $('btn-login').hidden = !!login || pending;
  $('btn-cancel-login').hidden = !pending;
  $('btn-token-toggle').hidden = !!login;
  $('btn-logout').hidden = !login;

  // step 3：仓库
  const repo = (state && state.config && state.config.repository) || '';
  const repoInput = $('repo-input');
  if (repoInput && document.activeElement !== repoInput && !repoDirty) repoInput.value = repo;
  $('repo-state').textContent = repo ? repo : pending ? '等待 GitHub 授权' : login ? '选择一个仓库' : '先登录';
  $('repo-state').className = 'step-state ' + (repo ? 'ok' : pending || login ? 'warn' : '');

  // step 4：授权人 + 发单人
  const allowed = (state && state.config && state.config.allowed) || [];
  const allowedInput = $('allowed-input');
  if (allowedInput && document.activeElement !== allowedInput) allowedInput.value = allowed.join(', ');
  $('people-state').textContent = allowed.length ? `${allowed.length} 人可派活` : '未设置（谁都不能派活）';
  $('people-state').className = 'step-state ' + (allowed.length ? 'ok' : 'warn');
  const poster = g.posterLogin || '';
  $('poster-state').textContent = poster ? `发单人：@${poster} ✓` : '发单人未登录（会话页开议题/回帖需要）';
  $('poster-state').className = 'step-state ' + (poster ? 'ok' : 'warn');

  // step 5：协作者
  const collab = g.collab || null;
  const collabOk = collab && collab.ok && /write|admin|maintain/i.test(collab.permission || '');
  $('collab-state').textContent = collab
    ? (collab.ok ? `@${collab.agent} 权限：${collab.permission}${collabOk ? ' ✓' : '（需要 Write）'}` : collab.error)
    : '待检测';
  $('collab-state').className = 'step-state ' + (collabOk ? 'ok' : collab ? 'warn' : '');
  $('btn-collab-invite').hidden = !!collabOk;

  // step 5：选中但未保存时给出明确状态，避免「选了却像没选」
  const picked = ($('repo-input').value || '').trim();
  if (picked && picked !== repo) {
    $('apply-state').textContent = `待保存：${picked}`;
    $('apply-state').className = 'step-state warn';
  }

  // 步骤高亮
  const setupOk = !!(state && state.state && state.state.setup && !state.state.setup.problem);
  const doneMap = { cli: cliDone, login: !!login, repo: !!repo, people: allowed.length > 0 && !!poster, collab: !!collabOk, apply: setupOk };
  let activeAssigned = false;
  document.querySelectorAll('.step').forEach((s) => {
    const done = !!doneMap[s.dataset.step];
    s.classList.toggle('done', done);
    const isActive = !done && !activeAssigned;
    if (isActive) activeAssigned = true;
    s.classList.toggle('active', isActive);
  });

  // 概览的主按钮随 GitHub 状态
  $('hero-primary').textContent = login ? '打开会话' : '去接入 GitHub';
}

/* ───────────────────────── 设置 ───────────────────────── */

let settingsLoaded = false;

async function loadSettingsBlock() {
  if (!state || state.phase !== 'running' || settingsLoaded) return;
  try {
    settingsData = await host.api('settings');
    const ex = (settingsData.blocks && settingsData.blocks.executor && settingsData.blocks.executor.value) || {};
    const dir = (state.config && state.config.directory) || ex.directory || '';
    const prep = (state.config && state.config.prepare) || ex.prepare || '';
    if (document.activeElement !== $('f-dir')) $('f-dir').value = dir;
    if (document.activeElement !== $('f-prepare')) $('f-prepare').value = prep;
    settingsLoaded = true;
  } catch {}
  try {
    const rv = await host.reviewGet();
    $('review-enabled').checked = !!rv.enabled;
    $('review-engine-note').textContent = rv.usingEngineKey ? '默认复用引擎的 DeepSeek 账号，无需填写' : '未检测到引擎 key：可手动填写，或用启发式评审';
    if (rv.llm) {
      $('review-baseurl').value = rv.llm.baseUrl || '';
      $('review-model').value = rv.llm.model || '';
    }
  } catch {}
}

function renderLogs(lines) {
  const box = $('logs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.textContent = lines.map((l) => `${hhmm(l.ts)} ${l.line}`).join('\n');
  if (near) box.scrollTop = box.scrollHeight;
}

/* ───────────────────────── 引擎 ───────────────────────── */

function loadEngine(u) {
  if (!u) return;
  $('dsh-empty').style.display = 'none';
  const wv = $('dsh');
  if (wv.getAttribute('src') !== u) wv.setAttribute('src', u);
}

/* ───────────────────────── 事件 ───────────────────────── */

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) return setPage(nav.dataset.page);

  const goto = e.target.closest('[data-goto]');
  if (goto) return setPage(goto.dataset.goto);

  const projSwitch = e.target.closest('[data-proj-switch]');
  if (projSwitch) return doSwitchProject(projSwitch.dataset.projSwitch);
  const projStart = e.target.closest('[data-proj-start]');
  if (projStart) {
    toast('启动项目引擎…');
    try { await host.projectsStart(projStart.dataset.projStart); await refreshProjects(); renderHost(await host.get()); } catch (err) { toast(err.message); }
    return;
  }
  const projCard = e.target.closest('.proj-card');
  if (projCard && projCard.dataset.proj !== (projectsData && projectsData.activeId)) return doSwitchProject(projCard.dataset.proj);

  const th = e.target.closest('[data-thread]');
  if (th) return openThread(th.dataset.thread);

  const tk = e.target.closest('[data-ticket]');
  if (tk) { setPage('tickets'); return openTicket(tk.dataset.ticket); }

  const evoBtn = e.target.closest('[data-evo-act]');
  if (evoBtn) return evoAction(evoBtn.dataset.evoAct, evoBtn.dataset.evoId);

  const sshBtn = e.target.closest('[data-ssh-act]');
  if (sshBtn) return sshAction(sshBtn.dataset.sshAct, sshBtn.dataset.sshId);

  const srvBtn = e.target.closest('[data-srv-act]');
  if (srvBtn) return srvAction(srvBtn.dataset.srvAct, srvBtn.dataset.srvId);

  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const seg = segBtn.parentElement;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === segBtn));
    if (seg.id === 'thread-filter') { threadFilter = segBtn.dataset.f; refreshThreads(); }
    if (seg.id === 'ticket-filter') { ticketFilter = segBtn.dataset.f; refreshTickets(); }
    return;
  }

  const repoItem = e.target.closest('.repo-item');
  if (repoItem) {
    $('repo-input').value = repoItem.dataset.name;
    $('repo-list').hidden = true;
    repoDirty = false;
    // 立即记住选择：否则 4s 周期渲染会用「已保存配置」把输入框清回空
    host.rememberRepo(repoItem.dataset.name).catch(() => {});
    return;
  }

  const clicked = e.target.closest('button');
  const id = clicked && clicked.id;

  if (id === 'btn-run' || id === 'btn-start-engine') {
    if (state && state.phase === 'running') {
      toast('正在停止…');
      await host.stop();
      renderHost(await host.get());
    } else {
      toast('启动中，首次会安装 bundle…');
      const r = await host.start();
      renderHost(r.state || (await host.get()));
      if (!r.ok) toast(r.error || '启动失败');
      else { toast('引擎已就绪'); if (page === 'overview') refreshOverview(); }
    }
    return;
  }
  if (id === 'btn-restart') {
    toast('重启中…');
    await host.restart();
    setTimeout(async () => renderHost(await host.get()), 1500);
    return;
  }
  if (id === 'btn-pause') {
    const paused = !!(state && state.state && state.state.paused);
    try { await host.pause(!paused); renderHost(await host.get()); toast(paused ? '已恢复处理' : '已暂停处理'); }
    catch (err) { toast(err.message); }
    return;
  }
  if (id === 'btn-log' || id === 'btn-open-log2') return host.openLog();
  if (id === 'btn-open-profile') return host.openProfile();
  if (id === 'btn-open-state') return host.openState();

  if (id === 'hero-primary') return setPage(gh && gh.login ? 'threads' : 'connect');
  if (id === 'hero-ghost') { renderHost(await host.refresh()); if (page === 'overview') refreshOverview(); return; }
  if (id === 'banner-go') return setPage('connect');
  if (id === 'go-tickets') return setPage('tickets');
  if (id === 'chip-repo') return setPage('connect');
  if (id === 'btn-ticket-refresh') return refreshTickets();
  if (id === 'btn-send') return sendMessage();

  // 进化
  if (id === 'btn-evo-run') {
    if (!state || state.phase !== 'running') return toast('先启动值守，进化需要读编排 API');
    $('btn-evo-run').disabled = true;
    toast('进化一轮：采集 → 分析 → 提案 → 应用…');
    try {
      const r = await host.evolutionRun();
      renderEvolution(r.snapshot);
      const x = r.result || {};
      toast(x.applied && x.applied.length ? `已应用 ${x.applied.length} 张提案，进入试用` : x.proposed && x.proposed.length ? `生成 ${x.proposed.length} 张提案` : `本轮采集 ${x.collected || 0} 条经验`);
    } catch (err) { toast('进化失败：' + err.message); }
    finally { $('btn-evo-run').disabled = false; }
    return;
  }
  if (id === 'btn-evo-refresh') return refreshEvolution();
  if (id === 'btn-evo-dir') return host.evolutionOpenDir();

  // 新任务
  if (id === 'btn-new-issue') return openIssueModal();
  if (id === 'btn-issue-cancel') { $('issue-modal').hidden = true; return; }
  if (id === 'btn-issue-submit') return submitIssue();
  if (id === 'btn-resync') {
    toast('重置读取基线…');
    try { const r = await host.resyncIssues(); toast(r.ok ? '已重置：现有开放议题将在下一轮被接收' : r.error); setTimeout(() => refreshThreads(), 4000); }
    catch (e) { toast(e.message); }
    return;
  }

  // 接入：发单人 / 协作者
  if (id === 'btn-poster-login') { await host.ghLoginStart(); renderGitHub(await host.ghStatus()); toast('浏览器已打开：用授权人（主）账号授权'); return; }
  if (id === 'btn-collab-check') {
    try { gh.collab = await host.collabStatus(); renderGitHub(gh); toast(gh.collab.ok ? `权限：${gh.collab.permission}` : gh.collab.error); } catch (e) { toast(e.message); }
    return;
  }
  if (id === 'btn-collab-invite') {
    try {
      const r = await host.collabInvite();
      if (!r.ok) throw new Error(r.error);
      toast('邀请已发出：用 agent 账号在 GitHub 接受');
      gh.collab = await host.collabStatus(); renderGitHub(gh);
    } catch (e) { toast(e.message); }
    return;
  }
  if (id === 'btn-collab-accept') {
    const repo = (state && state.config && state.config.repository) || '';
    return host.openExternal(`https://github.com/${repo}/invitations`);
  }

  // 服务器
  if (id === 'btn-srv-add') {
    try {
      await host.serversAdd({
        name: $('srv-name').value.trim(), host: $('srv-host').value.trim(),
        port: $('srv-port').value.trim(), username: $('srv-user').value.trim(),
        password: $('srv-pass').value, privateKey: $('srv-key').value.trim(),
        note: $('srv-note').value.trim()
      });
      ['srv-name', 'srv-host', 'srv-port', 'srv-user', 'srv-pass', 'srv-key', 'srv-note'].forEach((x) => { $(x).value = ''; });
      toast('服务器已保存（加密）');
      refreshServers();
    } catch (e) { toast(e.message); }
    return;
  }

  // SSH 密钥库
  if (id === 'btn-ssh-gen') {
    const name = $('ssh-name').value.trim() || 'superagent';
    toast('生成中…');
    try { await host.sshGenerate(name); $('ssh-name').value = ''; toast('已生成并入库'); refreshSsh(); } catch (e) { toast(e.message); }
    return;
  }
  if (id === 'btn-ssh-import-toggle') { $('ssh-import-row').hidden = !$('ssh-import-row').hidden; return; }
  if (id === 'btn-ssh-import') {
    try { await host.sshImport($('ssh-name').value.trim() || 'imported', $('ssh-import-text').value); $('ssh-import-text').value = ''; $('ssh-import-row').hidden = true; toast('已导入'); refreshSsh(); } catch (e) { toast(e.message); }
    return;
  }
  if (id === 'btn-ssh-test') {
    $('ssh-test-out').textContent = '测试中…';
    try { const r = await host.sshTest($('ssh-test-target').value.trim() || 'git@github.com'); $('ssh-test-out').textContent = (r.ok ? '✓ 连接成功\n' : '✗ 未通过\n') + r.output; }
    catch (e) { $('ssh-test-out').textContent = '✗ ' + e.message; }
    return;
  }

  // GitHub
  if (id === 'btn-install-gh') {
    $('btn-install-gh').disabled = true;
    toast('开始下载 gh CLI…');
    const r = await host.ghInstall();
    renderGitHub(await host.ghStatus());
    toast(r.ok ? 'gh 已安装' : '安装失败：' + (r.error || ''));
    return;
  }
  if (id === 'btn-pick-gh') {
    const g2 = await host.ghPick();
    renderGitHub(g2);
    if (g2.installed) toast('已使用：' + g2.path);
    return;
  }
  if (id === 'btn-login') {
    await host.ghLoginStart();
    renderGitHub(await host.ghStatus());
    toast(gh && gh.installed ? '浏览器已打开，输入一次性代码即可' : '浏览器已打开；gh 未安装时值守还读不到议题');
    return;
  }
  if (id === 'btn-cancel-login') { renderGitHub(await host.ghLoginCancel()); return; }
  if (id === 'btn-open-auth') {
    const uri = gh && gh.auth && gh.auth.verificationUri;
    if (uri) host.openAuth(`${uri}?user_code=${encodeURIComponent(gh.auth.userCode || '')}`);
    return;
  }
  if (id === 'btn-copy-code') {
    const code = $('device-code').textContent;
    try { await navigator.clipboard.writeText(code); toast('代码已复制'); } catch { toast(code); }
    return;
  }
  if (id === 'btn-logout') { await host.ghLogout(); renderGitHub(await host.ghStatus()); return; }
  if (id === 'btn-token-toggle') { $('token-row').hidden = !$('token-row').hidden; return; }
  if (id === 'btn-token-save') {
    const token = $('token-input').value.trim();
    if (!token) return toast('先粘贴 token');
    const r = await host.ghTokenLogin(token);
    renderGitHub(await host.ghStatus());
    toast(r.ok ? `已登录 @${r.login}` : '登录失败：' + r.error);
    return;
  }
  if (id === 'btn-list-repos') {
    $('btn-list-repos').disabled = true;
    try {
      const r = await host.ghRepos();
      if (!r.ok) throw new Error(r.error || '读取失败');
      const box = $('repo-list');
      box.hidden = false;
      box.innerHTML = r.items.length
        ? r.items.map((x) => `<div class="repo-item" data-name="${esc(x.name)}"><span class="nm">${esc(x.name)}</span>${x.private ? '<span class="lock">private</span>' : ''}<span class="ds">${esc(x.description || '')}</span></div>`).join('')
        : '<div class="empty sm"><span>这个账号没有可见仓库</span></div>';
    } catch (err) { toast('读取仓库失败：' + err.message); }
    finally { $('btn-list-repos').disabled = false; }
    return;
  }
  if (id === 'btn-apply' || id === 'btn-recheck') {
    const repository = $('repo-input').value.trim();
    const allowed = $('allowed-input').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    $('apply-state').textContent = '保存中…';
    $('apply-state').className = 'step-state warn';
    try {
      if (id === 'btn-apply') {
        if (!repository) throw new Error('先选一个仓库');
        await host.saveSetup({ repository, cli: (gh && gh.path) || '', allowed });
        repoDirty = false;
      }
      await host.setupCheck();
      const s = await host.get();
      renderHost(s);
      const prob = s.state && s.state.setup && s.state.setup.problem;
      $('apply-state').textContent = prob ? `仍有问题：${problemText(prob)}` : '已就绪 ✓';
      $('apply-state').className = 'step-state ' + (prob ? 'bad' : 'ok');
      toast(prob ? '保存了，但自检还有问题' : '配置已生效');
    } catch (err) {
      $('apply-state').textContent = '失败：' + err.message;
      $('apply-state').className = 'step-state bad';
    }
    return;
  }

  // 项目框架
  if (id === 'btn-add-project') { $('project-modal').hidden = false; $('proj-folder').focus(); return; }
  if (id === 'btn-proj-cancel') { $('project-modal').hidden = true; return; }
  if (id === 'btn-proj-pick') {
    const f = await host.projectsPickFolder();
    if (f) $('proj-folder').value = f;
    return;
  }
  if (id === 'btn-proj-create') {
    $('btn-proj-create').disabled = true;
    try {
      const r = await host.projectsAdd({
        folder: $('proj-folder').value.trim(),
        name: $('proj-name').value.trim(),
        createGithub: $('proj-github').checked,
        verify: $('proj-verify').value.trim()
      });
      if (!r.ok) throw new Error(r.error);
      $('project-modal').hidden = true;
      toast(r.project.repo ? `项目已添加并上传 ${r.project.repo}` : '项目已添加（本地）');
      await refreshProjects();
      await doSwitchProject(r.project.id);
    } catch (e) { toast(e.message); }
    finally { $('btn-proj-create').disabled = false; }
    return;
  }

  // 评审 agent
  if (id === 'btn-review-run') {
    toast('评审一轮…');
    try { const r = await host.reviewRun(); toast(r.acted && r.acted.length ? r.acted.map((a) => `PR#${a.pr}: ${a.verdict}`).join('；') : '没有待评审的工单'); } catch (e) { toast(e.message); }
    return;
  }
  if (id === 'btn-review-save') {
    const llm = $('review-baseurl').value.trim() ? { baseUrl: $('review-baseurl').value.trim(), model: $('review-model').value.trim(), apiKey: $('review-key').value.trim() } : null;
    try { await host.reviewSettings({ enabled: $('review-enabled').checked, llm }); toast('评审设置已保存'); } catch (e) { toast(e.message); }
    return;
  }

  // 设置
  if (id === 'btn-pick-dir') {
    const dir = await host.pickDir();
    if (dir) $('f-dir').value = dir;
    return;
  }
  if (id === 'btn-save-exec') {
    if (!state || state.phase !== 'running') return toast('先启动宿主');
    try {
      await host.saveSetup({ directory: $('f-dir').value.trim(), prepare: $('f-prepare').value });
      toast('已保存');
      renderHost(await host.get());
    } catch (err) { toast('保存失败：' + err.message); }
    return;
  }
});

$('thread-search').addEventListener('input', renderThreadList);
$('proj-switch-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('proj-switch-menu');
  m.hidden = !m.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#proj-switch')) $('proj-switch-menu').hidden = true;
});
$('repo-input').addEventListener('input', () => { repoDirty = true; });

$('evo-enabled').addEventListener('change', async (e) => {
  try { await host.evolutionSettings({ enabled: e.target.checked }); toast(e.target.checked ? '进化已启用' : '进化已停用（经验仍会采集）'); } catch (err) { toast(err.message); }
});
$('review-enabled').addEventListener('change', async (e) => {
  try { await host.reviewSettings({ enabled: e.target.checked }); toast(e.target.checked ? '自动评审已启用' : '自动评审已停用'); } catch (err) { toast(err.message); }
});
$('evo-autoapply').addEventListener('change', async (e) => {
  try { await host.evolutionSettings({ autoApply: e.target.checked }); toast(e.target.checked ? '安全提案将自动应用' : '所有提案都等你批准'); } catch (err) { toast(err.message); }
});

$('composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('composer-input').addEventListener('input', (e) => {
  const ta = e.target;
  ta.style.height = 'auto';
  ta.style.height = Math.min(132, ta.scrollHeight) + 'px';
});

host.onState((s) => renderHost(s));
host.onLog((l) => {
  if (!state) return;
  state.logs = (state.logs || []).concat([l]).slice(-300);
  renderLogs(state.logs);
});
host.onUrl((u) => { if (state) state.url = u; loadEngine(u); });
host.onGh((g) => renderGitHub(g));
host.onEvolution((s) => { if (page === 'evolution') renderEvolution(s); else evo = s; });
host.onSsh((s) => { if (page === 'ssh') renderSsh(s); else ssh = s; });
host.onServers((s) => { if (page === 'servers') renderServers(s); else servers = s; });

/* ───────────────────────── 引导 ───────────────────────── */

(async () => {
  const s = await host.get();
  renderHost(s);
  if (s.url) loadEngine(s.url);
  refreshGithub();
  if (s.phase === 'running') refreshOverview();

  setInterval(async () => {
    if (!state || state.phase !== 'running') return;
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try { renderHost(await host.refresh()); } catch {}
  }, 4000);

  setInterval(() => { if (page === 'threads' && state && state.phase === 'running') refreshThreads(); }, 8000);
})();
