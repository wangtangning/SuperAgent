'use strict';
/**
 * 进化引擎 · 经验采集（Experience）
 *
 * 从 bundle 的 /orchestrator/api 拉取真实运行记录（工单 / 决策 / 组件健康），
 * 归一化成「经验条目」追加到 experiences.jsonl（按 id 去重，只追加不改写）。
 * 这是自我进化闭环的第一环：没有经验，后面的一切都没有依据。
 */

/** 终局结果 → 质量分。merged 是仓库里真实合并的事实，权重最高。 */
const OUTCOME_SCORE = {
  merged: 1,
  completed: 0.9,
  closed: 0.45,
  stopped: 0.2,
  dropped: 0.15
};

/** 未结束工单的阶段性失败（person/failed、person/blocked）也计入失败经验。 */
const STAGE_FAIL = new Set(['person/failed', 'person/blocked']);

function outcomeScore(outcome) {
  if (outcome && Object.hasOwn(OUTCOME_SCORE, outcome)) return OUTCOME_SCORE[outcome];
  return 0.3;
}

/** 把失败/阻塞摘要归到一个粗粒度类别，供分析器聚合。 */
function classifyFailure(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'unknown';
  if (/(econnreset|etimedout|enotfound|network|proxy|fetch failed|timeout|超时|网络)/.test(t)) return 'network';
  if (/(permission|denied|eacces|unauthorized|403|401|权限|授权)/.test(t)) return 'permission';
  if (/(test|assert|expect|vitest|jest|失败|fail)/.test(t)) return 'verification';
  if (/(conflict|merge|rebase|冲突)/.test(t)) return 'merge-conflict';
  if (/(build|compile|tsc|typescript|syntax|构建|编译)/.test(t)) return 'build';
  if (/(missing|not found|enoent|找不到|不存在)/.test(t)) return 'missing-resource';
  return 'other';
}

/**
 * 归一化一条工单（tickets API 的 ticketLine 形状）为经验条目。
 * 返回 null 表示这条工单还没有可评价的信号。
 */
function normalizeTicket(t) {
  if (!t || !t.id) return null;
  const ended = t.ended || null;
  const stageKey = t.stage === 'person' && t.action ? `person/${t.action}` : String(t.stage || '');
  const failedStage = STAGE_FAIL.has(stageKey);
  if (!ended && !failedStage) return null; // 还在干活，等它结束再学

  const outcome = ended ? String(ended.outcome || ended.reason || 'closed') : null;
  const success = ended ? outcomeScore(outcome) >= 0.85 : false;
  const score = ended ? outcomeScore(outcome) : 0.1;
  const summary = String(t.summary || (t.note && t.note.text) || '').slice(0, 600);
  const attempts = Number(t.assignments || 0);
  return {
    id: `ticket:${t.id}:${ended ? `end:${outcome}` : `stage:${stageKey}`}`,
    kind: 'ticket',
    ticketId: t.id,
    title: String(t.title || '').slice(0, 200),
    at: ended ? ended.at : (t.updatedAt || new Date().toISOString()),
    outcome,
    stage: stageKey,
    success,
    score,
    attempts,
    // 一次就成 vs 反复重试：重试次数是执行质量最直接的信号
    retried: attempts > 1,
    failureClass: success ? null : classifyFailure(summary || t.title),
    summary,
    createdAt: t.createdAt || null,
    durationMs: ended && t.createdAt ? Math.max(0, Date.parse(ended.at) - Date.parse(t.createdAt)) : null
  };
}

/** 决策记录 → 经验条目（只学「拒绝/忽略」的分布，接受本身由工单结果来评价）。 */
function normalizeDecision(d) {
  if (!d || !d.decision_id) return null;
  const kind = String(d.kind || '');
  return {
    id: `decision:${d.decision_id}`,
    kind: 'decision',
    decisionKind: kind,
    at: d.at || new Date().toISOString(),
    reason: String(d.reason || '').slice(0, 300),
    ignored: /ignore|filter|reject/i.test(kind),
    accepted: /accept|dispatch/i.test(kind)
  };
}

/**
 * 采集一轮：拉 ended + person 工单和最近决策，返回新增的经验条目。
 * api.get(path) 由调用方注入（宿主里就是 apiGet），便于离线测试。
 */
async function collect(api, { decisionLimit = 100, ticketLimit = 200 } = {}) {
  const items = [];
  const errors = [];
  for (const state of ['ended', 'person']) {
    try {
      const r = await api.get(`tickets?state=${state}&limit=${ticketLimit}`);
      for (const t of (r && r.items) || []) {
        const e = normalizeTicket(t);
        if (e) items.push(e);
      }
    } catch (e) { errors.push(`tickets(${state}): ${e.message}`); }
  }
  try {
    const r = await api.get(`decisions?limit=${decisionLimit}`);
    for (const d of (r && r.items) || []) {
      const e = normalizeDecision(d);
      if (e) items.push(e);
    }
  } catch (e) { errors.push(`decisions: ${e.message}`); }
  return { items, errors };
}

/** 汇总一组工单经验为可比较的指标（进化前后对比就比这个）。 */
function summarize(experiences) {
  const tickets = experiences.filter((e) => e.kind === 'ticket' && e.outcome);
  const n = tickets.length;
  const successes = tickets.filter((e) => e.success).length;
  const retried = tickets.filter((e) => e.retried).length;
  const durations = tickets.map((e) => e.durationMs).filter((x) => Number.isFinite(x) && x > 0);
  const byClass = {};
  for (const e of tickets) {
    if (e.success) continue;
    const k = e.failureClass || 'other';
    byClass[k] = (byClass[k] || 0) + 1;
  }
  return {
    samples: n,
    successRate: n ? successes / n : null,
    retryRate: n ? retried / n : null,
    avgAttempts: n ? tickets.reduce((s, e) => s + e.attempts, 0) / n : null,
    avgDurationMs: durations.length ? durations.reduce((s, x) => s + x, 0) / durations.length : null,
    failureClasses: byClass
  };
}

module.exports = { collect, normalizeTicket, normalizeDecision, summarize, classifyFailure, outcomeScore, OUTCOME_SCORE };