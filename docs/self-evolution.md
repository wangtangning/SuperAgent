# SuperAgent 自我进化闭环

> 代码：`electron/evolution/`（引擎，不依赖 Electron，可离线测试）
> 界面：指挥台「进化」页 · 数据：`%APPDATA%\superagent-win\evolution\`
> 测试：`npm test`（10 个用例覆盖完整闭环）

## 它解决什么问题

值守 agent 每天都在产生真实运行经验——工单被合并、被关闭、反复重试、卡在网络上——
但这些经验原本只躺在 sqlite 里，不会影响下一次执行。自我进化闭环把这些经验变成
**可执行、可验证、可回滚**的系统改进：

```plain
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
  ①采集 ───→ ②分析 ───→ ③提案 ───→ ④验证+应用 ───→ ⑤试用 ───→ ⑥裁决 ─┘
  工单/决策    失败聚类    提示词/技能   preview 校验     真实工单     保留 or 回滚
  健康/负载    重试率      并发参数     版本化落地       成功率对比   （自动或人工）
```

每一环都有落盘证据：`experiences.jsonl`（①）、`proposals.json` 的 evidence 字段（②③）、
bundle 的 prompt revision 历史（④）、`metrics.json` 时间序列（⑤）、提案的 history 与
`evolution.log`（⑥）。

## 六个环节的实现

### ① 采集（`experience.js`）

每 60 秒（可配）从 bundle 的 `/orchestrator/api` 拉取：

| 来源 | 学到什么 |
| --- | --- |
| `tickets?state=ended` | 终局：`merged`(1.0) / `completed`(0.9) / `closed`(0.45) / `stopped`(0.2) / `dropped`(0.15)，执行次数、耗时、失败摘要 |
| `tickets?state=person` | 阶段性失败：`person/failed`、`person/blocked` |
| `decisions` | Policy 的接受/忽略分布 |
| `state.load` | 排队压力（连续 3 轮排队 ≥ 2×并发才触发，防抖） |

归一化成经验条目追加进 `experiences.jsonl`，按 id 去重、只追加不改写。
失败摘要按关键词归类：`network` / `permission` / `verification` / `merge-conflict` /
`build` / `missing-resource` / `other`。

### ② 分析（`analyzer.js` · analyze）

对全部工单经验计算：成功率、重试率、平均执行次数、失败分类分布。触发条件：

- **失败聚类**：某类失败 ≥3 次且占比 ≥30%（样本 ≥ `minSamples`）
- **反复重试**：>1 次执行的工单占比 ≥40%
- **成功率低**：整体成功率 ≤50%
- **排队压力**：连续 3 轮采集观察到排队 ≥ 2×并发上限

### ③ 提案（`analyzer.js` · propose）

发现 → 具体变更，两类：

**提示词/技能类**（合并成一张提案，一次只试一个变量，归因才干净）：
- 失败类别 → 对应的「经验教训」，合并进 `delivery` 段的 `<evolution-lessons>` 块
  （幂等：已有教训不重复追加）。教训内容与 bundle 内置提示词同语言（英文），
  例如 verification 类失败 → 「报告 ready 前先跑仓库自己的构建/测试并附上结果」。
- `network` 类失败 → 注册新技能 `windows-network-recovery`（Windows 网络故障的
  分步恢复策略）；无法归类的失败 → `failure-postmortem`（让失败报告变得可分析）。
- 技能通过 bundle 的 `config.skills` 注册，执行器会话原生可见。

**参数类**：排队压力 → `executor.maxWorkers` +1（上限 8，bundle 硬上限 16）。

防失控设计：同签名提案活跃时不重复提；同签名失败 3 次永久熔断；
失败后有 6 小时冷却；同时最多 1 个提示词类试用。

### ④ 验证 + 应用（`apply.js` · applyProposal）

**只走 bundle 公开 API，不碰它的内部存储**：

1. 读当前 prompt revision / settings revision；
2. `POST prompts/preview` —— bundle 做完整校验（占位符、长度、技能名、strict schema），
   不合法直接失败，不产生任何变更；
3. `PUT prompts`（带 `baseRevision` 乐观锁）/ `PUT settings/executor`（带 `revision`）。
   期间有人改过 → 409 冲突 → 提案标记 rejected，**绝不覆盖人的编辑**（有测试用例）；
4. 记录 `appliedSnapshot`（应用前完整快照）与 `baseline`（历史指标 + 已有经验 id 清单）。

生效语义由 bundle 保证：提示词 `effect: "next-request"`——下一个工单请求立即用新版本；
`maxWorkers` 保存即生效。这就是「改进后的能力在后续任务中可被实际使用」的机制。

### ⑤ 试用（trial）

应用后提案进入 `trial`。之后每轮采集都会把**新结束的工单**（不在 baselineIds 里、
结束时间晚于应用时间）归入试用样本，与基线对比。

### ⑥ 裁决（`apply.js` · evaluateTrials）

| 条件 | 裁决 |
| --- | --- |
| 成功率跌幅 ≥10pp 且 ≥2 个失败样本 | **立即自动回滚**（不等样本攒够） |
| 新样本 ≥3 或试用超 72h，成功率升 ≥5pp | 保留 |
| 成功率持平但重试率降 >5pp | 保留（同样产出更少返工） |
| 提示词类无劣化 | 保留（教训类文本，风险低） |
| 参数类无可测收益 / 到期零样本 | 回滚（保持最小变更） |

回滚 = 把 `appliedSnapshot` 原样写回（新版本号，bundle 的 revision 历史完整保留）。
「进化」页上人工随时可以：批准/驳回提案、立即裁决试用、回滚已保留的改进。

## 安全边界（刻意设计）

- **只改「怎么干活」，不改「允许干什么」**：Policy 规则、授权人（allowed）、eval 模式
  永远不自动改——那是人的权限语义，不是性能参数。
- 提示词变更先过 bundle 的 preview 校验；乐观锁保证不覆盖并发的人工编辑。
- `autoApply` 只对 `risk: 'safe'` 的提案生效；关掉后一切提案等人批准。
- 总开关 `enabled` 关掉后仍采集经验（数据不丢），只是不提案不应用。
- 所有阈值在 `evolution/settings.json` 可调（见 `store.js` 的 DEFAULT_SETTINGS）。

## 数据与证据

```plain
%APPDATA%\superagent-win\evolution\
  experiences.jsonl   经验流水（只追加）
  proposals.json      提案 + 全部状态迁移历史 + 应用快照 + 基线/试用指标
  metrics.json        每轮采集的指标快照（成功率走势曲线的数据源）
  evolution.log       人可读闭环日志
  settings.json       引擎开关与阈值
```

bundle 侧的证据在它的 prompt revision 历史里（「引擎」页或 `GET /orchestrator/api/prompts`
的 `revisions`），每次应用/回滚都是一个新版本，`source: "panel"`。

## 运行方式

- **自动**：宿主启动值守后每 30s 尝试一轮（引擎按 `collectIntervalMs` 节流），
  无需任何人工操作；「进化」页可看全过程。
- **手动**：「进化」页 →「立即进化一轮」强制跑完整闭环；提案卡片上批准/驳回/裁决/回滚。
- **离线验证**：`npm test` 用内存版 orchestrator API（语义与 bundle 一致）跑完整闭环，
  覆盖：采集去重、聚类触发、提案去重与熔断、应用生效、试用改善→保留、试用退化→自动回滚、
  参数上调与到期回滚、人工操作、乐观锁冲突保护。
- **实机演示**：`node scripts/evolution-demo.js`（见脚本头部说明）对本机运行中的 bundle
  跑一轮真实闭环并打印前后对比。

## 与宿主的关系

`electron/main.js` 只做三件事：注入 API 适配器（apiGet/apiPut/apiPost）、
定时 tick、把引擎快照推给「进化」页。引擎本身不依赖 Electron——
`EvolutionEngine({ api, store })` 在任何 Node 环境都能跑，这也是测试能离线闭环的原因。
## 评审 agent（person/review 自动化）

工单进入「等人评审」后，评审 agent（`electron/review-agent.js`，45s 一轮）自动处理：

1. 拉 PR 元数据 + diff；
2. **硬检查先行**：冲突 / 敏感路径（workflows、凭据、.env、密钥文件）/ 过大 → 不自动合并；
3. LLM 判定：默认**复用引擎已有的 DeepSeek key**（`~/.dsh/.credentials.yaml` 的
   `DEEPSEEK_API_KEY`），设置页可覆盖；LLM 失败回退启发式（小且聚焦、与请求相关）；
4. approve → 以**发单人**身份 squash 合并（工单随后 merged 结束，进入进化经验）；
   request_changes → 以发单人身份留评审意见，worker 收到反馈继续改；
   uncertain → 不动，留给人（工单页行动条）。

开关与配置在设置页「评审 agent」卡；`review:run` 可立即评审一轮。
