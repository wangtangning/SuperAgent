'use strict';
/**
 * 进化引擎 · 分析与提案（Analyzer）
 *
 * 从经验里找出可行动的「发现」（失败聚集 / 反复重试 / 成功率低 / 排队压力），
 * 再把发现映射成具体、可执行、可回滚的改进提案：
 *   - 提示词类：向 delivery 段追加「经验教训」块，或注册一个新技能（skill）
 *   - 参数类  ：executor.maxWorkers 并发上调
 *
 * 安全边界（刻意设计）：进化只改「怎么干活」，不改「允许干什么」——
 * Policy 规则、授权人、eval 模式永远不自动改，那些属于人的权限语义。
 */
const crypto = require('crypto');
const { summarize } = require('./experience');

const sig = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

/** 教训文本：英文，与 bundle 内置提示词同语言；每条对应一类失败。 */
const LESSONS = {
  verification: 'Before reporting ready, run the repository\'s own verification (build, typecheck, tests) for the code you changed and include the command results in the report; if verification cannot run, say why instead of claiming success.',
  build: 'After edits, compile or build the touched project before reporting ready, and fix build errors yourself before handing back.',
  'merge-conflict': 'Before opening or updating a PR, fetch the base branch and merge or rebase it into your branch, resolving conflicts yourself; never report ready on a branch that cannot merge.',
  permission: 'At the start of a ticket, verify the credentials and access the task needs (for GitHub work: gh auth status and repository access); when access is missing, report blocked immediately with the exact permission required instead of retrying blindly.',
  'missing-resource': 'Before editing, confirm every file, path or command the request names exists in the working directory; when one is missing, locate the intended target and state the mapping in the report, or ask when ambiguous.',
  'self-verify': 'Re-read the ticket\'s acceptance criteria before reporting ready and check each one against your actual diff; the ready report must name what was verified and how.'
};

/** 技能文本：失败类别 → 注册给执行器的新技能。 */
const SKILLS = {
  'windows-network-recovery': [
    '# Windows network recovery',
    '',
    'Use when a network step fails (fetch / git / gh / download) on this Windows host.',
    '',
    '1. Read the exact error first: DNS (ENOTFOUND), timeout (ETIMEDOUT), reset (ECONNRESET) and TLS errors need different fixes; do not retry blindly.',
    '2. Check `HTTP_PROXY` / `HTTPS_PROXY` environment variables. Node fetch does not read them; prefer `gh api` or `git` (they honor config) over raw fetch when a proxy is present.',
    '3. Retry with backoff at most 3 times, then switch strategy: another mirror, `gh api` instead of curl, or the GitHub REST API instead of scraping.',
    '4. After 3 distinct strategies fail, report blocked with the failing command, the exact error and what network access would unblock it. Never loop silently.'
  ].join('\n'),
  'failure-postmortem': [
    '# Failure postmortem',
    '',
    'Use whenever you are about to report blocked or failed.',
    '',
    'Structure the report summary so the next run can learn from it:',
    '1. What failed: the exact command or step, and the exact error text (keep it under 3 lines).',
    '2. Why: your best root-cause explanation, marked as fact or guess.',
    '3. What would unblock: the concrete change, permission, input or retry that would let this succeed.',
    '',
    'A report without these three parts wastes the failure; write them even when the cause is obvious.'
  ].join('\n')
};

const LESSON_BLOCK_OPEN = '<evolution-lessons>';
const LESSON_BLOCK_CLOSE = '</evolution-lessons>';

/** 把教训合并进 delivery 段：有块就往块里补，没有就新建块；已存在的教训不重复。 */
function mergeLessons(sectionText, lessonTexts) {
  const text = String(sectionText || '');
  const wanted = lessonTexts.filter(Boolean);
  const start = text.indexOf(LESSON_BLOCK_OPEN);
  const end = text.indexOf(LESSON_BLOCK_CLOSE);
  let existing = [];
  let head = text;
  if (start >= 0 && end > start) {
    existing = text.slice(start + LESSON_BLOCK_OPEN.length, end).split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean);
    head = text.slice(0, start).replace(/\s+$/, '');
  }
  const all = [...existing];
  for (const l of wanted) if (!all.includes(l)) all.push(l);
  const block = `${LESSON_BLOCK_OPEN}\n${all.map((l) => `- ${l}`).join('\n')}\n${LESSON_BLOCK_CLOSE}`;
  return `${head ? head + '\n\n' : ''}${block}`;
}

/**
 * 经验 → 发现。纯函数，便于测试。
 * loadPressureTicks：连续观察到「排队 ≥ 2×并发上限」的采集轮数（引擎传入）。
 */
function analyze(experiences, { minSamples = 3, loadPressureTicks = 0 } = {}) {
  const tickets = experiences.filter((e) => e.kind === 'ticket' && e.outcome);
  const stats = summarize(experiences);
  const findings = [];
  if (tickets.length >= minSamples) {
    const failures = tickets.filter((e) => !e.success);
    const byClass = {};
    for (const e of failures) {
      const k = e.failureClass || 'other';
      (byClass[k] = byClass[k] || []).push(e);
    }
    for (const [klass, list] of Object.entries(byClass)) {
      if (list.length >= 3 && list.length / tickets.length >= 0.3) {
        findings.push({
          type: 'failure-cluster',
          klass,
          count: list.length,
          share: list.length / tickets.length,
          examples: list.slice(-3).map((e) => ({ ticketId: e.ticketId, title: e.title, summary: e.summary })),
          stats
        });
      }
    }
    if (stats.retryRate != null && stats.retryRate >= 0.4) {
      findings.push({ type: 'retry-heavy', count: tickets.filter((e) => e.retried).length, share: stats.retryRate, examples: tickets.filter((e) => e.retried).slice(-3).map((e) => ({ ticketId: e.ticketId, title: e.title, summary: e.summary })), stats });
    }
    if (stats.successRate != null && stats.successRate <= 0.5) {
      findings.push({ type: 'low-success', count: tickets.length - tickets.filter((e) => e.success).length, share: 1 - stats.successRate, examples: failures.slice(-3).map((e) => ({ ticketId: e.ticketId, title: e.title, summary: e.summary })), stats });
    }
  }
  if (loadPressureTicks >= 3) {
    findings.push({ type: 'queue-pressure', count: loadPressureTicks, share: null, examples: [], stats });
  }
  return { findings, stats };
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/**
 * 发现 → 提案。context：{ prompts, settings, proposals, now, maxWorkersCap }
 * 返回新提案数组（已按签名去重 / 冷却 / 试用互斥过滤）。
 */
function propose(findings, context) {
  const { prompts, settings, proposals, now = Date.now(), maxWorkersCap = 8 } = context;
  const cfg = prompts && prompts.current ? prompts.current.config : { communication: '', scope: '', delivery: '', skills: {} };
  const out = [];

  const active = proposals.filter((p) => ['proposed', 'approved', 'trial', 'kept'].includes(p.status));
  const trialBusy = proposals.some((p) => p.status === 'trial' && p.kind === 'prompt');
  const blocked = (signature) => {
    if (active.some((p) => p.signature === signature)) return true;
    const dead = proposals.filter((p) => p.signature === signature && ['rolled_back', 'rejected'].includes(p.status));
    if (dead.length >= 3) return true; // 同一思路失败三次就不再试
    const last = dead.map((p) => p.updatedAt || p.createdAt).sort().pop();
    if (last && now - Date.parse(last) < (settings.cooldownMs || 0)) return true;
    return false;
  };

  const lessonKeys = new Set();
  const skillNames = new Set();
  const evidence = [];

  for (const f of findings) {
    if (f.type === 'failure-cluster') {
      evidence.push(`「${f.klass}」类失败 ${f.count} 次（占 ${pct(f.share)}）`);
      if (f.klass === 'network') skillNames.add('windows-network-recovery');
      else if (LESSONS[f.klass]) lessonKeys.add(f.klass);
      else skillNames.add('failure-postmortem'); // other/unknown：先让失败报告变得可分析
    }
    if (f.type === 'retry-heavy') {
      evidence.push(`反复重试的工单占 ${pct(f.share)}（${f.count} 张）`);
      lessonKeys.add('self-verify');
      lessonKeys.add('verification');
    }
    if (f.type === 'low-success') {
      evidence.push(`整体成功率只有 ${pct(f.stats.successRate)}`);
      lessonKeys.add('self-verify');
      skillNames.add('failure-postmortem');
    }
    if (f.type === 'queue-pressure') {
      const cur = Number((context.executorValue && context.executorValue.maxWorkers) || 3);
      const to = Math.min(cur + 1, maxWorkersCap);
      if (to > cur) {
        const signature = `executor:maxWorkers:${cur}->${to}`;
        if (!blocked(signature)) {
          out.push({
            id: `p-${now.toString(36)}-${sig(signature).slice(0, 6)}`,
            signature,
            kind: 'executor',
            risk: 'safe',
            title: `执行并发 ${cur} → ${to}`,
            rationale: `连续 ${f.count} 轮观察到排队数达到并发上限的 2 倍以上，上调一个并发位。`,
            evidence: { findings: [f.type], samples: f.count, examples: [] },
            change: { type: 'executor', field: 'maxWorkers', from: cur, to },
            status: 'proposed',
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            history: [{ at: new Date(now).toISOString(), to: 'proposed', note: '由排队压力触发' }]
          });
        }
      }
    }
  }

  // 提示词类合并成一张提案（一次只试一个变量，归因才干净）
  const lessons = [...lessonKeys].filter((k) => LESSONS[k]);
  const skills = [...skillNames].filter((n) => SKILLS[n] && !(cfg.skills && Object.hasOwn(cfg.skills, n) && cfg.skills[n] === SKILLS[n]));
  if ((lessons.length || skills.length) && !trialBusy) {
    const signature = `prompt:${sig([...lessons].sort().join('|') + '#' + [...skills].sort().join('|'))}`;
    if (!blocked(signature)) {
      const parts = [];
      if (lessons.length) parts.push(`delivery 段追加 ${lessons.length} 条经验教训（${lessons.join('、')}）`);
      if (skills.length) parts.push(`注册技能 ${skills.join('、')}`);
      out.push({
        id: `p-${now.toString(36)}-${sig(signature).slice(0, 6)}`,
        signature,
        kind: 'prompt',
        risk: 'safe',
        title: '执行经验固化：提示词与技能更新',
        rationale: `${evidence.join('；')}。把这些教训写进执行器提示词，下一个工单立即生效（bundle 原生 next-request 语义）。`,
        evidence: { findings: findings.map((f) => f.type), samples: findings.reduce((s, f) => s + (f.count || 0), 0), examples: findings.flatMap((f) => f.examples).slice(0, 5) },
        change: { type: 'prompt', lessons, skills: Object.fromEntries(skills.map((n) => [n, SKILLS[n]])) },
        status: 'proposed',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        history: [{ at: new Date(now).toISOString(), to: 'proposed', note: evidence.join('；') }]
      });
    }
  }
  return out;
}

/** 由提案 + 当前提示词配置构造新配置（应用时才调用，保证基于最新版本）。 */
function buildPromptConfig(currentConfig, change) {
  const cfg = JSON.parse(JSON.stringify(currentConfig));
  if (change.lessons && change.lessons.length) {
    cfg.delivery = mergeLessons(cfg.delivery, change.lessons.map((k) => LESSONS[k]).filter(Boolean));
  }
  if (change.skills) {
    cfg.skills = cfg.skills || {};
    for (const [name, text] of Object.entries(change.skills)) {
      // 不覆盖人已经写过的同名技能
      if (!Object.hasOwn(cfg.skills, name)) cfg.skills[name] = text;
    }
  }
  return cfg;
}

module.exports = { analyze, propose, buildPromptConfig, mergeLessons, LESSONS, SKILLS, LESSON_BLOCK_OPEN, LESSON_BLOCK_CLOSE };