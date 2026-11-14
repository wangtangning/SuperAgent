'use strict';
/**
 * 进化引擎离线测试：node --test test/evolution.test.js
 *
 * 用内存版 orchestrator API（语义与 bundle 一致：prompts 版本化 + baseRevision 乐观锁，
 * settings 块 revision 乐观锁）跑完整闭环，验证：
 *   采集去重 → 失败聚类 → 提案 → 预览校验 → 应用生效 → 试用裁决（保留/回滚）→ 回滚还原。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EvolutionStore } = require('../electron/evolution/store');
const { EvolutionEngine } = require('../electron/evolution/engine');
const experience = require('../electron/evolution/experience');
const analyzer = require('../electron/evolution/analyzer');

/* ── 内存版 orchestrator API ── */

function makeFakeApi() {
  const state = {
    prompts: { revision: 0, config: { communication: 'base-comm', scope: 'base-scope', delivery: 'base-delivery', skills: {} } },
    versions: new Map([[0, { communication: 'base-comm', scope: 'base-scope', delivery: 'base-delivery', skills: {} }]]),
    executor: { revision: 0, value: { model: null, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] } },
    tickets: [],
    decisions: [],
    load: { running: 0, queued: 0, maxWorkers: 3 },
    calls: []
  };
  const api = {
    async get(p) {
      state.calls.push(['GET', p]);
      if (p === 'prompts') return { current: { revision: state.prompts.revision, config: JSON.parse(JSON.stringify(state.prompts.config)) } };
      if (p === 'settings') return { blocks: { executor: JSON.parse(JSON.stringify(state.executor)) } };
      if (p === 'state') return { load: { ...state.load, maxWorkers: state.executor.value.maxWorkers } };
      if (p.startsWith('tickets')) {
        const m = p.match(/state=(\w+)/);
        const filter = m ? m[1] : 'open';
        const items = state.tickets.filter((t) => filter === 'ended' ? !!t.ended : (filter === 'person' ? (!t.ended && t.stage === 'person') : !t.ended));
        return { items: JSON.parse(JSON.stringify(items)), total: items.length };
      }
      if (p.startsWith('decisions')) return { items: JSON.parse(JSON.stringify(state.decisions)) };
      throw new Error('unknown GET ' + p);
    },
    async put(p, body) {
      state.calls.push(['PUT', p]);
      if (p === 'prompts') {
        if (body.baseRevision !== state.prompts.revision) throw new Error('409 conflict');
        const cfg = body.config;
        assert.ok(typeof cfg.communication === 'string' && typeof cfg.scope === 'string' && typeof cfg.delivery === 'string', 'prompt config shape');
        state.prompts = { revision: state.prompts.revision + 1, config: JSON.parse(JSON.stringify(cfg)) };
        state.versions.set(state.prompts.revision, JSON.parse(JSON.stringify(cfg)));
        return { revision: state.prompts.revision, effect: 'next-request' };
      }
      if (p === 'settings/executor') {
        if (body.revision !== state.executor.revision) throw new Error('409 conflict');
        state.executor = { revision: state.executor.revision + 1, value: JSON.parse(JSON.stringify(body.value)) };
        return { saved: true, revision: state.executor.revision, restarting: false };
      }
      throw new Error('unknown PUT ' + p);
    },
    async post(p, body) {
      state.calls.push(['POST', p]);
      if (p === 'prompts/preview') {
        const cfg = body; // 与真实 bundle 一致：preview 的 body 就是 config 本身
        if (!cfg || typeof cfg.delivery !== 'string') throw new Error('400 invalid');
        return { orchestrator: 'composed', worker: 'composed:' + cfg.delivery, skills: cfg.skills || {} };
      }
      throw new Error('unknown POST ' + p);
    }
  };
  return { api, state };
}

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new EvolutionStore(dir);
}

let ticketSeq = 0;
function endedTicket(outcome, { summary = '', attempts = 1, at = new Date().toISOString(), title = 'fix something' } = {}) {
  ticketSeq += 1;
  return {
    id: `t-${ticketSeq}`,
    title,
    stage: 'ended',
    assignments: attempts,
    inputs: 1,
    summary,
    createdAt: new Date(Date.parse(at) - 3600000).toISOString(),
    updatedAt: at,
    ended: { at, by: 'system', outcome }
  };
}

/* ── 单元：经验归一化与汇总 ── */

test('normalizeTicket：终局与阶段性失败', () => {
  const merged = experience.normalizeTicket(endedTicket('merged', { attempts: 1 }));
  assert.equal(merged.success, true);
  assert.equal(merged.score, 1);
  const failed = experience.normalizeTicket({ id: 'x', title: 't', stage: 'person', action: 'failed', summary: 'tests assert failed', assignments: 3, updatedAt: new Date().toISOString() });
  assert.equal(failed.success, false);
  assert.equal(failed.failureClass, 'verification');
  assert.equal(failed.retried, true);
  assert.equal(experience.normalizeTicket({ id: 'y', stage: 'working' }), null);
});

test('summarize：成功率 / 重试率 / 失败分类', () => {
  const items = [
    experience.normalizeTicket(endedTicket('merged')),
    experience.normalizeTicket(endedTicket('completed')),
    experience.normalizeTicket(endedTicket('closed', { summary: 'ETIMEDOUT fetch failed', attempts: 4 })),
    experience.normalizeTicket(endedTicket('dropped', { summary: 'network timeout' }))
  ];
  const s = experience.summarize(items);
  assert.equal(s.samples, 4);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.retryRate, 0.25);
  assert.equal(s.failureClasses.network, 2);
});

test('mergeLessons：幂等合并，不重复追加', () => {
  const one = analyzer.mergeLessons('base', [analyzer.LESSONS.verification]);
  const two = analyzer.mergeLessons(one, [analyzer.LESSONS.verification, analyzer.LESSONS.build]);
  assert.equal((two.match(/Before reporting ready/g) || []).length, 1);
  assert.ok(two.includes(analyzer.LESSONS.build));
  assert.ok(two.startsWith('base'));
});

/* ── 单元：分析与提案 ── */

test('analyze：失败聚类触发；样本不足不触发', () => {
  const few = [experience.normalizeTicket(endedTicket('closed', { summary: 'tests failed' }))];
  assert.equal(analyzer.analyze(few, { minSamples: 3 }).findings.length, 0);
  const many = [];
  for (let i = 0; i < 4; i++) many.push(experience.normalizeTicket(endedTicket('closed', { summary: 'vitest assert failed', attempts: 2 })));
  many.push(experience.normalizeTicket(endedTicket('merged')));
  const { findings } = analyzer.analyze(many, { minSamples: 3 });
  const types = findings.map((f) => f.type);
  assert.ok(types.includes('failure-cluster'));
  assert.ok(types.includes('retry-heavy') || types.includes('low-success'));
});

test('propose：聚类 → 提示词提案；同签名去重；三次失败后熔断', () => {
  const many = [];
  for (let i = 0; i < 4; i++) many.push(experience.normalizeTicket(endedTicket('closed', { summary: 'vitest assert failed', attempts: 2 })));
  const { findings } = analyzer.analyze(many, { minSamples: 3 });
  const ctx = {
    prompts: { current: { revision: 0, config: { communication: '', scope: '', delivery: '', skills: {} } } },
    settings: { cooldownMs: 0 },
    proposals: [],
    now: Date.now()
  };
  const p1 = analyzer.propose(findings, ctx);
  assert.equal(p1.length, 1);
  assert.equal(p1[0].kind, 'prompt');
  assert.ok(p1[0].change.lessons.includes('verification'));
  // 已有同签名活跃提案 → 不再提
  const p2 = analyzer.propose(findings, { ...ctx, proposals: p1 });
  assert.equal(p2.length, 0);
  // 同签名失败三次 → 熔断
  const dead = [1, 2, 3].map((i) => ({ ...p1[0], id: 'd' + i, status: 'rolled_back', updatedAt: new Date().toISOString() }));
  assert.equal(analyzer.propose(findings, { ...ctx, proposals: dead }).length, 0);
});

/* ── 集成：完整闭环（保留路径） ── */

test('闭环：失败经验 → 提案 → 应用 → 试用改善 → 保留', async (t) => {
  const store = tmpStore(t);
  const { api, state } = makeFakeApi();
  const engine = new EvolutionEngine({ api, store });

  // 第一阶段：4 个验证类失败 + 1 个成功 → 成功率 20%
  const base = Date.now();
  for (let i = 0; i < 4; i++) {
    state.tickets.push(endedTicket('closed', { summary: 'vitest assert failed: expected 2 got 3', attempts: 3, at: new Date(base - 86400000 + i * 1000).toISOString() }));
  }
  state.tickets.push(endedTicket('merged', { at: new Date(base - 86400000).toISOString() }));

  const r1 = await engine.tick({ force: true });
  assert.ok(r1.collected >= 5);
  assert.equal(r1.proposed.length, 1);
  assert.equal(r1.applied.length, 1);

  // 提示词真的变了：delivery 带教训块，版本推进
  assert.equal(state.prompts.revision, 1);
  assert.ok(state.prompts.config.delivery.includes('<evolution-lessons>'));
  assert.ok(state.prompts.config.delivery.includes('verification'));
  const proposal = store.proposals()[0];
  assert.equal(proposal.status, 'trial');
  assert.equal(proposal.appliedSnapshot.before.revision, 0);
  assert.ok(Math.abs(proposal.baseline.successRate - 0.2) < 1e-9);

  // 采集去重：同样数据再跑一轮，不新增
  const r2 = await engine.tick({ force: true });
  assert.equal(r2.collected, 0);

  // 第二阶段：应用之后 3 个 merged → 试用成功率 100%
  for (let i = 0; i < 3; i++) {
    state.tickets.push(endedTicket('merged', { at: new Date(Date.now() + 1000 + i).toISOString() }));
  }
  const r3 = await engine.tick({ force: true });
  assert.equal(r3.verdicts.length, 1);
  assert.equal(r3.verdicts[0].verdict, 'kept');
  const kept = store.proposals()[0];
  assert.equal(kept.status, 'kept');
  assert.equal(kept.trial.successRate, 1);
  // 提示词保持改进后的版本
  assert.ok(state.prompts.config.delivery.includes('<evolution-lessons>'));
  // 指标时间序列存在且能看出前后对比
  const metrics = store.metrics();
  assert.ok(metrics.length >= 3);
  assert.ok(metrics[metrics.length - 1].successRate > metrics[0].successRate);
});

/* ── 集成：完整闭环（回滚路径） ── */

test('闭环：试用退化 → 自动回滚，提示词还原', async (t) => {
  const store = tmpStore(t);
  const { api, state } = makeFakeApi();
  const engine = new EvolutionEngine({ api, store });

  const base = Date.now();
  for (let i = 0; i < 4; i++) {
    state.tickets.push(endedTicket('closed', { summary: 'build compile error tsc', attempts: 2, at: new Date(base - 86400000 + i * 1000).toISOString() }));
  }
  state.tickets.push(endedTicket('merged', { at: new Date(base - 86400000).toISOString() }));
  await engine.tick({ force: true });
  assert.equal(store.proposals()[0].status, 'trial');
  const appliedDelivery = state.prompts.config.delivery;
  assert.ok(appliedDelivery.includes('<evolution-lessons>'));

  // 应用后连续失败（≥2 个失败样本 + 跌幅超阈值 → 立即回滚）
  for (let i = 0; i < 3; i++) {
    state.tickets.push(endedTicket('closed', { summary: 'still failing', at: new Date(Date.now() + 1000 + i).toISOString() }));
  }
  const r = await engine.tick({ force: true });
  assert.equal(r.verdicts[0].verdict, 'rolled_back');
  const p = store.proposals()[0];
  assert.equal(p.status, 'rolled_back');
  // 内容还原到应用前（版本号前进，历史保留）
  assert.equal(state.prompts.config.delivery, 'base-delivery');
  assert.ok(state.prompts.revision >= 2);
  assert.deepEqual(state.prompts.config, state.versions.get(0));
});

/* ── 集成：参数类提案（排队压力） ── */

test('闭环：连续排队压力 → maxWorkers 上调；无收益到期回滚', async (t) => {
  const store = tmpStore(t);
  store.saveSettings({ trialMaxHours: 0 }); // 到期立即裁决
  const { api, state } = makeFakeApi();
  const engine = new EvolutionEngine({ api, store });
  state.load = { running: 3, queued: 8, maxWorkers: 3 };

  await engine.tick({ force: true });
  await engine.tick({ force: true });
  const r3 = await engine.tick({ force: true });
  assert.ok(r3.proposed.length >= 1);
  assert.equal(state.executor.value.maxWorkers, 4);
  const p = store.proposals().find((x) => x.kind === 'executor');
  assert.equal(p.status, 'trial');

  // 无新工单样本 + 到期 → 回滚还原
  const r4 = await engine.tick({ force: true });
  assert.ok(r4.verdicts.some((v) => v.id === p.id && v.verdict === 'rolled_back'));
  assert.equal(state.executor.value.maxWorkers, 3);
});

/* ── 集成：人工操作 ── */

test('人工：驳回 / 批准应用 / 手动回滚', async (t) => {
  const store = tmpStore(t);
  const { api, state } = makeFakeApi();
  const engine = new EvolutionEngine({ api, store });
  store.saveSettings({ autoApply: false });

  const base = Date.now();
  for (let i = 0; i < 4; i++) state.tickets.push(endedTicket('closed', { summary: 'tests assert failed', attempts: 2, at: new Date(base - 86400000 + i).toISOString() }));
  await engine.tick({ force: true });
  const p = store.proposals()[0];
  assert.equal(p.status, 'proposed'); // autoApply 关闭 → 停在提案

  engine.reject(p.id, '不想改提示词');
  assert.equal(store.getProposal(p.id).status, 'rejected');

  // 新签名（不同教训组合）再提一张，走批准 → 应用 → 手动回滚
  state.tickets.push(endedTicket('closed', { summary: 'ECONNRESET network fetch failed', attempts: 1, at: new Date(base - 86400000).toISOString() }));
  state.tickets.push(endedTicket('closed', { summary: 'ETIMEDOUT network', attempts: 1, at: new Date(base - 86400000).toISOString() }));
  state.tickets.push(endedTicket('closed', { summary: 'network proxy fetch failed', attempts: 1, at: new Date(base - 86400000).toISOString() }));
  await engine.tick({ force: true });
  const p2 = store.proposals().find((x) => x.status === 'proposed');
  assert.ok(p2, '应有新提案');
  await engine.approveAndApply(p2.id);
  assert.equal(store.getProposal(p2.id).status, 'trial');
  await engine.rollback(p2.id, '人工回滚测试');
  assert.equal(store.getProposal(p2.id).status, 'rolled_back');
  assert.deepEqual(state.prompts.config, state.versions.get(0));
});

/* ── 冲突安全：应用期间版本被人改动 → 乐观锁拒绝，不产生半成品 ── */

test('乐观锁：baseRevision 过期时应用失败且提案被标记', async (t) => {
  const store = tmpStore(t);
  const { api, state } = makeFakeApi();
  const engine = new EvolutionEngine({ api, store });
  const base = Date.now();
  for (let i = 0; i < 4; i++) state.tickets.push(endedTicket('closed', { summary: 'tests assert failed', attempts: 2, at: new Date(base - 86400000 + i).toISOString() }));

  // 在 preview 与 save 之间模拟一次外部保存
  const origPost = api.post;
  api.post = async (p, body) => {
    const r = await origPost(p, body);
    if (p === 'prompts/preview') await api.put('prompts', { config: { communication: 'human-edit', scope: 'base-scope', delivery: 'base-delivery', skills: {} }, baseRevision: state.prompts.revision });
    return r;
  };
  const r = await engine.tick({ force: true });
  assert.equal(r.applied.length, 0);
  const p = store.proposals()[0];
  assert.equal(p.status, 'rejected');
  assert.ok(p.history.some((h) => /conflict/i.test(h.note)));
  // 人的编辑没有被覆盖
  assert.equal(state.prompts.config.communication, 'human-edit');
});