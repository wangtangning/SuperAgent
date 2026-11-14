'use strict';
/**
 * 实机进化演示：对本机运行中的 dsh-superagent bundle 跑真实闭环。
 *
 *   node scripts/evolution-demo.js            # 只跑采集/分析（无副作用）
 *   node scripts/evolution-demo.js --apply    # 额外演示：真实应用一张提案 → 验证生效 → 回滚还原
 *
 * --apply 的每一步都走 bundle 公开 API（preview 校验 + 乐观锁），全程打印前后对比；
 * 结束时提示词内容还原到演示前（revision 历史保留，可在引擎页查看）。
 * 经验/提案/日志写入独立的演示数据目录，不污染宿主的正式进化数据。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EvolutionStore } = require('../electron/evolution/store');
const { EvolutionEngine } = require('../electron/evolution/engine');
const { buildPromptConfig } = require('../electron/evolution/analyzer');

const BASE = 'http://127.0.0.1:3082/orchestrator/api/';
const HEADERS = { 'x-orchestrator-request': '1', accept: 'application/json' };

const api = {
  async get(p) {
    const res = await fetch(BASE + p, { headers: HEADERS });
    const j = await res.json();
    if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${j.error || ''}`);
    return j;
  },
  async put(p, body) {
    const res = await fetch(BASE + p, { method: 'PUT', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(`PUT ${p} → ${res.status} ${j.error || JSON.stringify(j.issues || '')}`);
    return j;
  },
  async post(p, body) {
    const res = await fetch(BASE + p, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await res.json();
    if (!res.ok) throw new Error(`POST ${p} → ${res.status} ${j.error || ''}`);
    return j;
  }
};

const line = (s = '') => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);

async function main() {
  const apply = process.argv.includes('--apply');
  const dir = path.join(__dirname, '..', '.tmp', 'evolution-demo');
  fs.mkdirSync(dir, { recursive: true });
  const store = new EvolutionStore(dir);
  const engine = new EvolutionEngine({ api, store, log: (l) => console.log('  [log] ' + l) });

  head('0. 环境');
  const state = await api.get('state');
  line(`bundle 存活：masterId=${state.masterId}  paused=${state.paused}`);
  const before = await api.get('prompts');
  line(`当前提示词 revision=${before.current.revision}  delivery 长度=${before.current.config.delivery.length}`);
  line(`演示数据目录：${dir}`);

  head('1. 真实采集 + 分析（无副作用）');
  const r = await engine.tick({ force: true });
  line(`采集新经验 ${r.collected} 条；发现 [${r.findings.join(', ') || '无'}]；提案 ${r.proposed.length} 张`);
  line(`当前经验库指标：${JSON.stringify(r.stats)}`);

  if (!apply) {
    line('\n（只读演示结束；加 --apply 看真实应用→验证→回滚）');
    return;
  }

  head('2. 构造一张真实提案（delivery 追加一条可验证的教训）');
  const marker = 'Before reporting ready, name the exact verification command you ran and its result in the report summary.';
  const proposal = {
    id: `p-demo-${Date.now().toString(36)}`,
    signature: `demo:${Date.now()}`,
    kind: 'prompt',
    risk: 'safe',
    title: '演示：ready 报告必须附上验证命令与结果',
    rationale: '实机演示自我进化闭环的应用/验证/回滚路径。',
    evidence: { findings: ['demo'], samples: 0, examples: [] },
    change: { type: 'prompt', lessons: [], skills: {} },
    status: 'proposed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), to: 'proposed', note: '演示提案' }]
  };
  const { mergeLessons } = require('../electron/evolution/analyzer');
  const nextConfig = buildPromptConfig(before.current.config, { lessons: [], skills: {} });
  nextConfig.delivery = mergeLessons(nextConfig.delivery, [marker]);
  store.upsertProposal(proposal);

  head('3. preview 校验（bundle 原生验证，不合法会在这里失败）');
  const preview = await api.post('prompts/preview', nextConfig);
  line(`preview 通过：worker 提示词合成 ${preview.worker.length} 字符，orchestrator ${preview.orchestrator.length} 字符`);
  line(`worker 提示词包含新教训：${preview.worker.includes(marker)}`);

  head('4. 真实应用（PUT prompts，乐观锁 baseRevision=' + before.current.revision + '）');
  const saved = await api.put('prompts', { config: nextConfig, baseRevision: before.current.revision });
  line(`保存成功：revision ${before.current.revision} → ${saved.revision}，effect=${saved.effect}（下一个请求即生效）`);
  const after = await api.get('prompts');
  line(`回读验证：当前 revision=${after.current.revision}，delivery 包含教训块=${after.current.config.delivery.includes('<evolution-lessons>')}，包含新教训=${after.current.config.delivery.includes(marker)}`);
  line(`delivery 长度：${before.current.config.delivery.length} → ${after.current.config.delivery.length}`);

  head('5. 回滚还原（把演示前的配置原样写回）');
  const restored = await api.put('prompts', { config: before.current.config, baseRevision: after.current.revision });
  line(`回滚成功：revision ${after.current.revision} → ${restored.revision}`);
  const final = await api.get('prompts');
  const same = JSON.stringify(final.current.config) === JSON.stringify(before.current.config);
  line(`回读验证：配置与演示前完全一致=${same}`);
  line(`revision 历史（引擎页可见）：${(final.revisions || []).slice(0, 4).map((v) => 'r' + v.revision + '(' + v.source + ')').join(' ← ')}`);

  head('结果');
  line(same ? '✓ 实机闭环演示完成：应用生效、内容还原、历史留痕' : '✗ 还原不一致，请检查');
  process.exitCode = same ? 0 : 1;
}

main().catch((e) => { console.error('演示失败：', e.message); process.exit(1); });