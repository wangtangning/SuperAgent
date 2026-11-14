# 会话可见性审计与优化方案

> 触发问题：「怎么没有回复的？」——会话页只看到自动评审的 CHANGES_REQUESTED，
> 看不到 worker 的回应。本文审计 bundle 是否具备相应能力、缺陷在哪、如何优化。

## 审计结论：bundle 有能力，宿主 UI 没用上

| 能力 | bundle 是否具备 | 证据 |
| --- | --- | --- |
| 订阅 PR 线程 | ✅ | `github-watch` 对 `observePulls/observeComments` 的 PR/评论流接收；`thread.correlated` 记录关联线程 |
| 线程时间线 | ✅ | `GET threads/:key` 返回 `timeline`（triggerView：actor/at/text/url/disposition） |
| 关联线程列表 | ✅ | `threadDetail.correlated: [{key,title}]` |
| worker 在 PR 上回复 | ✅ | 实测 PR #2 有 wtnagent001 的核对评论 |
| 会话页聚合显示 | ❌ 缺陷 | 旧 UI 只渲染当前 issue 线程的 timeline，PR 上的回复不可见 |

即：**不是 agent 没回复，是回复在 PR 线程上，而会话页只画了 issue 线程**。

## 已实施的优化（本次）

1. **聚合时间线**：`openThread` 拉取当前线程 + 最多 4 个 `correlated` 线程的
   timeline，按 id 去重、按时间倒序合并渲染；跨线程消息带来源标签（如「#2 chore: …」）。
   会话页从此同时可见 issue 与 PR 上的全部往来。
2. **actor 渲染**：对象 actor 正确取 name/id（此前 [object Object]）。
3. **评审可见性**：自动评审的 CHANGES_REQUESTED 与 worker 的核对回复同屏，
   人能直接判断「评审→回应→修改」闭环是否转动。

## 仍存在的缺陷与后续方案

| # | 缺陷 | 方案 |
| --- | --- | --- |
| 1 | worker 承诺「随后给出核对结果」后 idle，未兑现 | 宿主加「承诺兑现 watchdog」：报告含「随后/稍后/将会」且 N 分钟无新动作时，自动 requeue 提醒；或进化引擎把「承诺未兑现」记为失败经验 |
| 2 | 评审与 worker 对同一 diff 反复拉锯（重复 review 轮） | 评审 agent 增加「同 commit 已评审且 worker 已回应」去重：同 sha 不重复发 CHANGES_REQUESTED，改为汇总一条 |
| 3 | 会话页回复框只能回 issue | 聚合视图下回复框增加目标选择（issue / PR），默认 issue |
| 4 | 评审误报（SHA256SUMS 与 package.json 一致性） | 评审 prompt 增加「lockfile/校验和类文件与源文件同改视为一致」规则，降低 false positive |

## 验证

- 实机：会话页打开 #1，聚合显示 #2 PR 的评审与 worker 核对评论（带来源标签）。
- 回归：`npm test` 27/27。