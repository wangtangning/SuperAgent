'use strict';
/**
 * 进化引擎 · 持久化（Store）
 *
 * 全部状态落在宿主 userData 的 evolution/ 目录，不碰 bundle 的 sqlite：
 *   experiences.jsonl   经验流水（只追加，按 id 去重）
 *   proposals.json      改进提案与它们的全部状态迁移
 *   metrics.json        每轮采集后的指标快照（时间序列）
 *   evolution.log       人可读的闭环日志（同时也是验证证据）
 *   settings.json       进化引擎自身的开关与阈值
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  enabled: true,            // 总开关：关掉后只采集经验，不提案不应用
  autoApply: true,          // 自动应用「安全类」提案（提示词/技能/并发）；权限类永远要人批
  collectIntervalMs: 60000, // 采集周期
  minSamples: 3,            // 触发分析所需的最少工单样本
  trialMinSamples: 3,       // 试用期结束所需的最少新工单样本
  trialMaxHours: 72,        // 试用期最长时长（超过就按现有样本裁决）
  improveMargin: 0.05,      // 成功率至少提升 5 个百分点才算「更好」
  regressMargin: 0.10,      // 成功率跌超过 10 个百分点立刻回滚
  maxActiveTrials: 1,       // 同时只允许一个提示词类试用，避免归因混淆
  cooldownMs: 6 * 3600000   // 同一签名提案的冷却时间
};

class EvolutionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.experiencesFile = path.join(dir, 'experiences.jsonl');
    this.proposalsFile = path.join(dir, 'proposals.json');
    this.metricsFile = path.join(dir, 'metrics.json');
    this.logFile = path.join(dir, 'evolution.log');
    this.settingsFile = path.join(dir, 'settings.json');
    this._seen = null;
  }

  /* ── 经验 ── */

  _seenIds() {
    if (this._seen) return this._seen;
    const set = new Set();
    try {
      const text = fs.readFileSync(this.experiencesFile, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { set.add(JSON.parse(line).id); } catch {}
      }
    } catch {}
    this._seen = set;
    return set;
  }

  /** 追加新经验，返回真正新增的条数（重复 id 跳过）。 */
  appendExperiences(items) {
    const seen = this._seenIds();
    const fresh = items.filter((e) => e && e.id && !seen.has(e.id));
    if (!fresh.length) return 0;
    const text = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(this.experiencesFile, text, 'utf8');
    for (const e of fresh) seen.add(e.id);
    return fresh.length;
  }

  experiences({ since = null, kind = null } = {}) {
    const out = [];
    let text = '';
    try { text = fs.readFileSync(this.experiencesFile, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (kind && e.kind !== kind) continue;
        if (since && Date.parse(e.at) < since) continue;
        out.push(e);
      } catch {}
    }
    return out;
  }

  /* ── 提案 ── */

  proposals() {
    try { return JSON.parse(fs.readFileSync(this.proposalsFile, 'utf8')); } catch { return []; }
  }

  saveProposals(list) {
    const tmp = this.proposalsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.proposalsFile);
  }

  getProposal(id) {
    return this.proposals().find((p) => p.id === id) || null;
  }

  upsertProposal(proposal) {
    const list = this.proposals();
    const i = list.findIndex((p) => p.id === proposal.id);
    if (i >= 0) list[i] = proposal; else list.push(proposal);
    this.saveProposals(list);
    return proposal;
  }

  /* ── 指标时间序列 ── */

  metrics() {
    try { return JSON.parse(fs.readFileSync(this.metricsFile, 'utf8')); } catch { return []; }
  }

  pushMetrics(entry) {
    const list = this.metrics();
    list.push(entry);
    if (list.length > 2000) list.splice(0, list.length - 2000);
    const tmp = this.metricsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.metricsFile);
    return entry;
  }

  /* ── 日志 ── */

  log(line, level = 'info') {
    const text = `${new Date().toISOString()} [${level}] ${line}\n`;
    try { fs.appendFileSync(this.logFile, text, 'utf8'); } catch {}
    return text;
  }

  readLog(maxLines = 200) {
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } catch { return []; }
  }

  /* ── 设置 ── */

  settings() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch {}
    return Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  saveSettings(patch) {
    const next = Object.assign({}, this.settings(), patch || {});
    fs.writeFileSync(this.settingsFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

module.exports = { EvolutionStore, DEFAULT_SETTINGS };