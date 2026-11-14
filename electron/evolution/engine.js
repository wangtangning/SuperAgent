'use strict';
/**
 * 进化引擎 · 编排（Engine）
 *
 * 闭环：采集(collect) → 分析(analyze) → 提案(propose) → 应用(apply)
 *       → 试用(trial) → 裁决(keep / rollback) → 下一轮采集……
 *
 * 宿主每隔 collectIntervalMs 调一次 tick()（仅运行中）；UI 的按钮走 runNow / apply / rollback。
 * 引擎本身不依赖 Electron：api / store / log 全部注入，node --test 可以离线跑完整闭环。
 */
const experience = require('./experience');
const analyzer = require('./analyzer');
const apply = require('./apply');

class EvolutionEngine {
  /** deps: { api: {get,put,post}, store: EvolutionStore, log?, onChange?, isRunning? } */
  constructor(deps) {
    this.api = deps.api;
    this.store = deps.store;
    this.log = (line, level) => {
      this.store.log(line, level);
      if (deps.log) deps.log(`[evolution] ${line}`, level);
    };
    this.onChange = deps.onChange || (() => {});
    this.isRunning = deps.isRunning || (() => true);
    this._ticking = false;
    this._loadPressureTicks = 0;
    this._lastTickAt = 0;
    this._lastError = '';
  }

  deps() { return { api: this.api, store: this.store, log: (l, lv) => this.log(l, lv) }; }

  /** 一轮闭环。force=true 时忽略采集间隔（UI「立即进化一轮」）。 */
  async tick({ force = false } = {}) {
    if (this._ticking) return { skipped: 'busy' };
    if (!this.isRunning()) return { skipped: 'not-running' };
    const cfg = this.store.settings();
    const now = Date.now();
    if (!force && now - this._lastTickAt < cfg.collectIntervalMs) return { skipped: 'interval' };
    this._ticking = true;
    this._lastTickAt = now;
    const result = { collected: 0, findings: [], proposed: [], applied: [], verdicts: [], stats: null };
    try {
      // 1. 采集
      const { items, errors } = await experience.collect(this.api);
      result.collected = this.store.appendExperiences(items);
      if (errors.length) this.log(`采集部分失败：${errors.join('；')}`, 'warn');
      if (result.collected) this.log(`采集到 ${result.collected} 条新经验`);

      // 2. 排队压力（连续观察，避免单次抖动就调参）
      try {
        const st = await this.api.get('state');
        const load = (st && st.load) || {};
        if (load.maxWorkers && load.queued >= load.maxWorkers * 2) this._loadPressureTicks += 1;
        else this._loadPressureTicks = 0;
      } catch {}

      // 3. 指标快照（每轮都记，时间序列就是效果曲线）
      const all = this.store.experiences();
      const stats = experience.summarize(all);
      result.stats = stats;
      this.store.pushMetrics({ at: new Date().toISOString(), ...stats, experiences: all.length });

      // 4. 裁决进行中的试用（先裁决再提新案，保证同时最多一个提示词试用）
      result.verdicts = await apply.evaluateTrials(this.deps());

      // 5. 分析与提案
      if (cfg.enabled) {
        const { findings } = analyzer.analyze(all, { minSamples: cfg.minSamples, loadPressureTicks: this._loadPressureTicks });
        result.findings = findings.map((f) => f.type);
        if (findings.length) {
          const prompts = await this.api.get('prompts').catch(() => null);
          const settingsView = await this.api.get('settings').catch(() => null);
          const fresh = analyzer.propose(findings, {
            prompts,
            settings: cfg,
            proposals: this.store.proposals(),
            executorValue: settingsView && settingsView.blocks && settingsView.blocks.executor && settingsView.blocks.executor.value,
            now
          });
          for (const p of fresh) {
            this.store.upsertProposal(p);
            this.log(`新提案 ${p.id}「${p.title}」：${p.rationale}`);
            result.proposed.push(p.id);
          }
          // 6. 自动应用安全类提案
          if (cfg.autoApply) {
            for (const p of this.store.proposals().filter((x) => x.status === 'proposed' && x.risk === 'safe')) {
              try {
                await apply.applyProposal(p, this.deps());
                result.applied.push(p.id);
              } catch (e) {
                this.log(`提案 ${p.id} 应用失败：${e.message}`, 'error');
                apply.transition(p, 'rejected', `应用失败：${e.message}`);
                this.store.upsertProposal(p);
              }
            }
          }
        }
      }
      this._lastError = '';
    } catch (e) {
      this._lastError = e.message;
      this.log(`本轮进化失败：${e.message}`, 'error');
    } finally {
      this._ticking = false;
      this.onChange();
    }
    return result;
  }

  /** UI：立即跑一轮完整闭环。 */
  async runNow() { return this.tick({ force: true }); }

  /** UI：人工批准并应用一张提案。 */
  async approveAndApply(id) {
    const p = this.store.getProposal(id);
    if (!p) throw new Error('提案不存在');
    if (p.status !== 'proposed') throw new Error(`提案状态 ${p.status}，不能批准`);
    apply.transition(p, 'approved', '人工批准');
    this.store.upsertProposal(p);
    return apply.applyProposal(p, this.deps());
  }

  /** UI：人工驳回。 */
  reject(id, reason) {
    const p = this.store.getProposal(id);
    if (!p) throw new Error('提案不存在');
    if (!['proposed', 'approved'].includes(p.status)) throw new Error(`提案状态 ${p.status}，不能驳回`);
    apply.transition(p, 'rejected', reason || '人工驳回');
    this.store.upsertProposal(p);
    this.log(`提案 ${id} 被人工驳回`);
    return p;
  }

  /** UI：人工回滚（试用中或已保留的都可以）。 */
  async rollback(id, reason) {
    const p = this.store.getProposal(id);
    if (!p) throw new Error('提案不存在');
    if (!['trial', 'kept'].includes(p.status)) throw new Error(`提案状态 ${p.status}，没有可回滚的应用`);
    return apply.rollbackProposal(p, this.deps(), reason || '人工回滚');
  }

  /** UI：立即裁决试用（不等样本阈值，按现有数据）。 */
  async evaluateNow(id) {
    const p = this.store.getProposal(id);
    if (!p || p.status !== 'trial') throw new Error('没有进行中的试用');
    const all = this.store.experiences();
    const seen = new Set(p.baselineIds || []);
    const fresh = all.filter((e) => e.kind === 'ticket' && e.outcome && !seen.has(e.id) && Date.parse(e.at) >= Date.parse(p.appliedAt));
    const trialStats = experience.summarize(fresh);
    const base = p.baseline || {};
    const delta = trialStats.successRate != null && base.successRate != null ? trialStats.successRate - base.successRate : null;
    const cfg = this.store.settings();
    if (trialStats.samples === 0) throw new Error('试用还没有新工单样本，无法裁决');
    if (delta != null && delta <= -cfg.regressMargin) {
      await apply.rollbackProposal(p, this.deps(), `人工裁决：成功率下降 ${Math.round(-delta * 100)}pp`);
    } else {
      apply.keepProposal(p, this.store, trialStats, `人工裁决保留（Δ ${delta == null ? '—' : Math.round(delta * 100) + 'pp'}，${trialStats.samples} 单）`);
      this.log(`提案 ${p.id} 人工裁决保留`);
    }
    return this.store.getProposal(id);
  }

  /** UI 快照。 */
  snapshot() {
    const all = this.store.experiences();
    const proposals = this.store.proposals().slice().reverse();
    const metrics = this.store.metrics();
    return {
      settings: this.store.settings(),
      stats: experience.summarize(all),
      experienceCount: all.length,
      recentExperiences: all.slice(-40).reverse(),
      proposals,
      metrics: metrics.slice(-120),
      log: this.store.readLog(120),
      lastTickAt: this._lastTickAt || null,
      lastError: this._lastError,
      busy: this._ticking
    };
  }
}

module.exports = { EvolutionEngine };