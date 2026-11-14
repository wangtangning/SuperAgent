'use strict';
/**
 * 进化引擎 · 应用与验证（Apply / Trial / Rollback）
 *
 * 应用只走 bundle 自己的公开 API，不碰它的内部存储：
 *   提示词/技能 → PUT prompts   （带 baseRevision 乐观锁 + POST prompts/preview 先验证）
 *   并发参数    → PUT settings/executor（带 revision 乐观锁）
 *
 * 每次应用都记录「应用前快照」，回滚就是把快照原样写回（新版本号，历史不丢）。
 * 试用期用真实工单结果裁决：成功率提升 → 保留；明显退化 → 自动回滚；样本不足 → 到期按现有数据裁决。
 */
const { summarize } = require('./experience');
const { buildPromptConfig } = require('./analyzer');

function transition(p, to, note) {
  p.status = to;
  p.updatedAt = new Date().toISOString();
  p.history = p.history || [];
  p.history.push({ at: p.updatedAt, to, note: String(note || '').slice(0, 500) });
  return p;
}

/**
 * 应用一张提案。deps：{ api, store, log }
 * 成功后提案进入 trial，并带上 baseline（历史指标）与 appliedSnapshot（回滚依据）。
 */
async function applyProposal(p, deps) {
  const { api, store, log = () => {} } = deps;
  if (!['proposed', 'approved'].includes(p.status)) throw new Error(`提案状态 ${p.status} 不能应用`);

  const all = store.experiences();
  const baseline = summarize(all);
  const baselineIds = all.filter((e) => e.kind === 'ticket').map((e) => e.id);

  if (p.change.type === 'prompt') {
    const view = await api.get('prompts');
    const before = JSON.parse(JSON.stringify(view.current));
    const nextConfig = buildPromptConfig(before.config, p.change);
    if (JSON.stringify(nextConfig) === JSON.stringify(before.config)) {
      transition(p, 'kept', '当前提示词已包含这些改进，无需变更');
      store.upsertProposal(p);
      return p;
    }
    // 先预览：bundle 会做完整校验（占位符 / 长度 / 技能名），不合法直接失败，不产生任何变更
    // 注意：preview 的 body 就是 config 本身（PUT prompts 才是 {config, baseRevision} 包装）
    const preview = await api.post('prompts/preview', nextConfig);
    if (!preview || !preview.worker) throw new Error('提示词预览失败：bundle 未返回合成结果');
    const saved = await api.put('prompts', { config: nextConfig, baseRevision: before.revision });
    p.appliedSnapshot = { type: 'prompt', before, afterRevision: saved.revision };
    log(`已应用提示词提案 ${p.id}：revision ${before.revision} → ${saved.revision}（${p.change.lessons.join('、') || ''}${p.change.skills && Object.keys(p.change.skills).length ? ' +技能 ' + Object.keys(p.change.skills).join('、') : ''}）`);
  } else if (p.change.type === 'executor') {
    const settings = await api.get('settings');
    const block = settings.blocks.executor;
    const before = JSON.parse(JSON.stringify(block));
    const value = Object.assign({}, block.value, { [p.change.field]: p.change.to });
    const saved = await api.put('settings/executor', { value, revision: block.revision });
    p.appliedSnapshot = { type: 'executor', before, afterRevision: saved.revision };
    log(`已应用参数提案 ${p.id}：executor.${p.change.field} ${p.change.from} → ${p.change.to}`);
  } else {
    throw new Error(`未知的变更类型 ${p.change.type}`);
  }

  p.baseline = baseline;
  p.baselineIds = baselineIds;
  p.appliedAt = new Date().toISOString();
  transition(p, 'trial', `开始试用：基线成功率 ${baseline.successRate == null ? '无样本' : Math.round(baseline.successRate * 100) + '%'}（${baseline.samples} 单）`);
  store.upsertProposal(p);
  return p;
}

/** 回滚：把应用前快照写回（提示词整份还原 / 参数单字段还原）。 */
async function rollbackProposal(p, deps, reason) {
  const { api, store, log = () => {} } = deps;
  if (!p.appliedSnapshot) throw new Error('这张提案没有可回滚的应用快照');
  const snap = p.appliedSnapshot;
  if (snap.type === 'prompt') {
    const view = await api.get('prompts');
    const saved = await api.put('prompts', { config: snap.before.config, baseRevision: view.current.revision });
    log(`已回滚提示词提案 ${p.id}：revision ${view.current.revision} → ${saved.revision}（还原到 r${snap.before.revision} 的内容）。原因：${reason}`);
  } else if (snap.type === 'executor') {
    const settings = await api.get('settings');
    const block = settings.blocks.executor;
    const value = Object.assign({}, block.value, { [p.change.field]: snap.before.value[p.change.field] });
    await api.put('settings/executor', { value, revision: block.revision });
    log(`已回滚参数提案 ${p.id}：executor.${p.change.field} 还原为 ${snap.before.value[p.change.field]}。原因：${reason}`);
  }
  transition(p, 'rolled_back', reason);
  store.upsertProposal(p);
  return p;
}

/** 保留：改进转正，试用期指标存档为对比证据。 */
function keepProposal(p, store, trialStats, note) {
  p.trial = trialStats;
  transition(p, 'kept', note);
  store.upsertProposal(p);
  return p;
}

/**
 * 裁决所有试用期提案。返回本轮发生的裁决事件（供日志 / UI）。
 * 规则：
 *   新样本 ≥ trialMinSamples 或试用超过 trialMaxHours → 裁决；
 *   成功率差 ≥ +improveMargin → 保留；≤ -regressMargin → 回滚；
 *   介于两者之间：重试率下降也算改善（同样工作量更少返工），否则按「不劣化即保留」处理提示词类，
 *   参数类无收益则回滚（少动为妙）。
 */
async function evaluateTrials(deps) {
  const { api, store, log = () => {} } = deps;
  const cfg = store.settings();
  const events = [];
  const all = store.experiences();
  for (const p of store.proposals().filter((x) => x.status === 'trial')) {
    const appliedAt = Date.parse(p.appliedAt || p.updatedAt);
    const seen = new Set(p.baselineIds || []);
    const fresh = all.filter((e) => e.kind === 'ticket' && e.outcome && !seen.has(e.id) && Date.parse(e.at) >= appliedAt);
    const trialStats = summarize(fresh);
    const ageH = (Date.now() - appliedAt) / 3600000;
    const enough = trialStats.samples >= cfg.trialMinSamples;
    const expired = ageH >= cfg.trialMaxHours;

    const base = p.baseline || { successRate: null, retryRate: null, samples: 0 };
    const delta = trialStats.successRate != null && base.successRate != null
      ? trialStats.successRate - base.successRate : null;

    // 明显退化：不等样本攒够，立刻回滚（至少 2 个失败样本才触发，避免单个偶发失败误杀）
    const freshFails = fresh.filter((e) => !e.success).length;
    if (delta != null && delta <= -cfg.regressMargin && freshFails >= 2) {
      await rollbackProposal(p, deps, `试用退化：成功率 ${Math.round(base.successRate * 100)}% → ${Math.round(trialStats.successRate * 100)}%（${trialStats.samples} 单）`);
      events.push({ id: p.id, verdict: 'rolled_back', delta, trial: trialStats });
      continue;
    }
    if (!enough && !expired) continue;

    let verdict;
    let note;
    if (trialStats.samples === 0) {
      // 到期仍无新工单：无法证明有效，回滚以保持系统最小变更
      verdict = 'rolled_back';
      note = `试用 ${Math.round(ageH)}h 无新工单样本，无法验证效果，回滚保持最小变更`;
    } else if (delta != null && delta >= cfg.improveMargin) {
      verdict = 'kept';
      note = `成功率 ${Math.round(base.successRate * 100)}% → ${Math.round(trialStats.successRate * 100)}%（+${Math.round(delta * 100)}pp，${trialStats.samples} 单）`;
    } else if (delta != null && delta <= -cfg.regressMargin) {
      verdict = 'rolled_back';
      note = `成功率下降 ${Math.round(-delta * 100)}pp（${trialStats.samples} 单）`;
    } else {
      const retryBetter = trialStats.retryRate != null && base.retryRate != null && trialStats.retryRate < base.retryRate - 0.05;
      if (retryBetter) {
        verdict = 'kept';
        note = `成功率持平，重试率 ${Math.round(base.retryRate * 100)}% → ${Math.round(trialStats.retryRate * 100)}%（返工减少）`;
      } else if (p.kind === 'prompt') {
        verdict = 'kept';
        note = `成功率无劣化（Δ ${delta == null ? '—' : Math.round(delta * 100) + 'pp'}），教训类提示词保留`;
      } else {
        verdict = 'rolled_back';
        note = '参数调整未带来可测收益，还原';
      }
    }
    if (verdict === 'kept') {
      keepProposal(p, store, trialStats, note);
      log(`提案 ${p.id} 保留：${note}`);
    } else {
      await rollbackProposal(p, deps, note);
    }
    events.push({ id: p.id, verdict, delta, trial: trialStats, note });
  }
  return events;
}

module.exports = { applyProposal, rollbackProposal, keepProposal, evaluateTrials, transition };