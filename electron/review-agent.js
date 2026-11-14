'use strict';
/**
 * 评审 agent：工单进入 person/review 后自动评审 PR。
 *
 * 流程：拉 PR 元数据 + diff → 启发式 + 可选 LLM 判定 →
 *   approve：用发单人 token 合并（squash），工单随后以 merged 结束；
 *   request_changes：以发单人身份在 PR 上留评审意见，worker 会收到 CI/评审反馈继续改；
 *   uncertain：不动，留给人（工单页行动条）。
 *
 * 安全默认：diff 为空 / 过大 / 含敏感路径（.github/workflows、凭据文件等）→ 不自动合并。
 * LLM 可选：userData/review.json 配 { baseUrl, apiKey, model }（OpenAI 兼容）；没配就用启发式。
 */
const fs = require('fs');
const path = require('path');

const SENSITIVE = /(^|\/)(\.github\/workflows\/|\.env|.*secret.*|.*credential.*|.*\.pem$|.*\.key$)/i;
const MAX_DIFF = 60000;
const MAX_FILES = 20;

function heuristic({ pr, diff, request }) {
  const files = (pr.files || []).map((f) => f.filename);
  if (!diff || !diff.trim()) return { verdict: 'uncertain', reason: 'PR 没有 diff' };
  if (diff.length > MAX_DIFF || files.length > MAX_FILES) return { verdict: 'uncertain', reason: `改动过大（${files.length} 文件 / ${diff.length} 字符），留给人评审` };
  const sensitive = files.filter((f) => SENSITIVE.test(f));
  if (sensitive.length) return { verdict: 'uncertain', reason: '含敏感路径：' + sensitive.join(', ') };
  if (pr.mergeable === false) return { verdict: 'request_changes', reason: 'PR 与基线冲突，需要 rebase/解决冲突' };
  // 请求与改动的相关性：请求里的关键词（文件名/标识符）应出现在 diff 或文件名里
  const tokens = String(request || '').match(/[A-Za-z0-9_.-]{4,}/g) || [];
  const hit = tokens.filter((t) => diff.includes(t) || files.some((f) => f.includes(t)));
  if (tokens.length && !hit.length) return { verdict: 'uncertain', reason: 'diff 与请求关键词无交集，留给人确认' };
  return { verdict: 'approve', reason: `改动小且聚焦（${files.length} 文件），与请求相关，无敏感路径` };
}

async function llmJudge(cfg, { pr, diff, request }) {
  const prompt = [
    'You are a strict code reviewer for a small-change maintenance agent.',
    `Original request: ${request || pr.title}`,
    `PR title: ${pr.title}`,
    `Files: ${(pr.files || []).map((f) => f.filename).join(', ')}`,
    'Diff:',
    diff.slice(0, 20000),
    '',
    'Reply with JSON only: {"verdict":"approve"|"request_changes"|"uncertain","reason":"one sentence"}',
    'approve only if the diff fulfills the request, stays in scope, and looks correct.'
  ].join('\n');
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, temperature: 0, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error('LLM ' + res.status);
  const j = await res.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 返回不含 JSON');
  const v = JSON.parse(m[0]);
  if (!['approve', 'request_changes', 'uncertain'].includes(v.verdict)) throw new Error('LLM verdict 非法');
  return v;
}

class ReviewAgent {
  /** deps: { api, gh: {get,post,put} (poster token REST), store, log, onChange } */
  constructor(deps) {
    this.api = deps.api;
    this.gh = deps.gh;
    this.store = deps.store;
    this.log = deps.log || (() => {});
    this.onChange = deps.onChange || (() => {});
    this.llmOverride = deps.llm === undefined ? undefined : deps.llm;
    this._busy = false;
    this._done = new Map(); // ticketId -> verdict
  }

  settings() {
    const f = path.join(this.store.dir, 'review.json');
    try { return Object.assign({ enabled: true, llm: null }, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return { enabled: true, llm: null }; }
  }

  /** 没显式配 LLM 时，复用引擎已有的 DeepSeek key（~/.dsh/.credentials.yaml refs）。 */
  effectiveLlm() {
    if (this.llmOverride !== undefined) return this.llmOverride;
    const cfg = this.settings();
    if (cfg.llm && cfg.llm.baseUrl && cfg.llm.apiKey) return cfg.llm;
    try {
      const os = require('os');
      const yaml = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
      const m = yaml.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      if (m) return { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: m[1] };
    } catch {}
    return null;
  }
  saveSettings(patch) {
    const f = path.join(this.store.dir, 'review.json');
    const next = Object.assign(this.settings(), patch || {});
    fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  async tick() {
    if (this._busy) return { skipped: 'busy' };
    const cfg = this.settings();
    if (!cfg.enabled) return { skipped: 'disabled' };
    this._busy = true;
    const acted = [];
    try {
      const r = await this.api.get('tickets?state=person&limit=20');
      for (const t of (r && r.items) || []) {
        if (t.action !== 'review' || this._done.has(t.id)) continue;
        try {
          const verdict = await this.reviewTicket(t, cfg);
          this._done.set(t.id, verdict.verdict);
          acted.push({ ticket: t.id, ...verdict });
        } catch (e) {
          this.log(`评审 ${t.id} 失败：${e.message}`, 'error');
        }
      }
    } catch (e) {
      this.log('评审轮询失败：' + e.message, 'error');
    } finally {
      this._busy = false;
      if (acted.length) this.onChange();
    }
    return { acted };
  }

  async reviewTicket(t, cfg) {
    const detail = await this.api.get(`tickets/${encodeURIComponent(t.id)}`);
    const threads = detail.threads || [];
    const thread = threads.find((x) => /\/pull\/\d+/.test(x.url || '')) || threads.find((x) => /^github:\d+$/.test(x.key || '')) || {};
    const m = /^github:(\d+)$/.exec(thread.key || '');
    const repo = thread.url ? (thread.url.match(/github\.com\/([^/]+\/[^/]+)\//) || [])[1] : null;
    if (!m || !repo) return { verdict: 'uncertain', reason: '找不到 PR 线程' };
    const num = Number(m[1]);
    const pr = await this.gh.get(`repos/${repo}/pulls/${num}`);
    if (pr.state !== 'open') return { verdict: 'uncertain', reason: 'PR 已不是 open' };
    const diff = await this.gh.get(`repos/${repo}/pulls/${num}`, { accept: 'application/vnd.github.diff' });
    const request = (detail.mandate && (detail.mandate.scope || detail.mandate.request)) || t.title;

    // 硬检查：冲突 / 敏感 / 过大 不交给 LLM 裁决
    const hard = heuristic({ pr, diff, request });
    let verdict;
    const llm = this.effectiveLlm();
    if (hard.verdict !== 'approve') {
      verdict = hard;
    } else if (llm) {
      try { verdict = await llmJudge(llm, { pr, diff, request }); }
      catch (e) { this.log(`LLM 评审失败，回退启发式：${e.message}`, 'warn'); verdict = hard; }
    } else {
      verdict = hard;
    }
    this.log(`评审 PR #${num}（${t.title}）→ ${verdict.verdict}：${verdict.reason}`);

    if (verdict.verdict === 'approve') {
      await this.gh.put(`repos/${repo}/pulls/${num}/merge`, { merge_method: 'squash', commit_title: `${pr.title} (#${num})` });
      this.log(`评审 agent 已合并 PR #${num}`);
    } else if (verdict.verdict === 'request_changes') {
      await this.gh.post(`repos/${repo}/pulls/${num}/reviews`, { event: 'REQUEST_CHANGES', body: `自动评审：${verdict.reason}` });
    }
    return { ...verdict, pr: num };
  }
}

module.exports = { ReviewAgent, heuristic };