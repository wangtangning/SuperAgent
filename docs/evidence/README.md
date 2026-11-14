# 验证证据（2026-11-14）

自我进化闭环与图标更换的实机验证记录。所有日志均为真实运行输出，非方案描述。

## 1. 离线闭环测试（`npm test`）

`unit-tests.log`：10/10 通过。用内存版 orchestrator API（语义与 bundle 一致：
prompts 版本化 + baseRevision 乐观锁、settings revision 乐观锁、preview 校验）覆盖：

- 经验归一化 / 汇总 / 教训幂等合并
- 失败聚类触发、样本不足不触发
- 提案签名去重、三次失败熔断
- **完整闭环·保留路径**：失败经验 → 提案 → 应用（revision 0→1，delivery 出现教训块）
  → 后续 3 单 merged → 试用成功率 20%→100% → 自动保留；指标时间序列可见前后对比
- **完整闭环·回滚路径**：应用后连续失败 → 自动回滚，提示词内容逐字节还原（revision 前进、历史保留）
- 参数类：连续排队压力 → maxWorkers 3→4；到期无收益 → 回滚还原
- 人工驳回 / 批准应用 / 手动回滚
- 乐观锁：应用期间被人并发编辑 → 409 → 提案 rejected，人的编辑不被覆盖

## 2. 实机闭环演示（`node scripts/evolution-demo.js --apply`）

`live-demo.log`：对本机运行中的 dsh-superagent bundle（127.0.0.1:3082）真实执行：

```plain
preview 通过：worker 提示词合成 31841 字符（bundle 原生校验）
保存成功：revision 0 → 1，effect=next-request（下一个工单请求即生效）
回读验证：delivery 包含教训块=true，包含新教训=true（4102 → 4252 字符）
回滚成功：revision 1 → 2；配置与演示前完全一致=true
revision 历史：r2(panel) ← r1(panel) ← r0(defaults)
```

证明：改进真实落地、生效语义为 next-request、可完整回滚、历史留痕。

## 3. 宿主集成

- 打包产物 `dist/win-unpacked/resources/app.asar` 内含 `electron/evolution/*` 五个模块、
  「进化」页与 `build/icon.png`（asar 解包核对）。
- 新实例启动后 `%APPDATA%\superagent-win\evolution\` 自动出现
  `evolution.log`（"进化引擎已装载"）与 `metrics.json`（首轮采集快照）——引擎随值守自动运行。
- `shots/16-evolution.png`：进化页实机截图（闭环流程、指标卡、走势、日志、提案、经验）。
- `shots/17-new-logo.png`：新品牌标识实机截图。

## 4. 图标

- `build/icon.ico`：16/24/32/48/64/128/256 七尺寸；`build/icon.png` 1024。
- 从重建后的 `SuperAgent.exe` 提取嵌入图标（`.tmp/exe-icon.png`，32×32）确认已生效。
- 生成脚本 `scripts/make-icon.js`（`npm run icon`），源文件 `assets/icon.svg`。

## 5. 接入页「选完就消失」修复

- 复现：CDP 驱动真实界面，点选仓库后输入框在 ≤500ms 内被清空。
- 定位：setter 陷阱捕获调用栈 → 4s 周期 `renderHost → renderGitHub` 用「已保存配置」
  （空）覆盖仅存在于输入框的选择。
- 修复：选中即 `host:rememberRepo` 持久化到宿主配置；手动输入加脏值保护；
  第 5 步显示「待保存：<repo>」。修复后复测见 `repo-fix-verify.log`。

## 6. 本次新增 / 修改文件清单

新增：
```plain
electron/evolution/experience.js   经验采集与归一化
electron/evolution/store.js        进化数据持久化
electron/evolution/analyzer.js     分析、提案、教训/技能库
electron/evolution/apply.js        应用、试用裁决、回滚
electron/evolution/engine.js       闭环编排
test/evolution.test.js             离线闭环测试（10 用例）
scripts/make-icon.js               图标生成
scripts/evolution-demo.js          实机闭环演示
docs/self-evolution.md             闭环设计与运行文档
docs/evidence/                     本目录（日志与说明）
assets/icon.svg  build/icon.png  build/icon.ico
```

修改：
```plain
electron/main.js      进化引擎接线、IPC、周期 tick、rememberRepo、窗口图标
electron/preload.js   进化与 rememberRepo 的 contextBridge 白名单
ui/index.html         「进化」页、新品牌 logo
ui/app.js             进化页渲染与交互、仓库选择修复
ui/style.css          进化页样式
package.json          test/icon 脚本、win.icon、nsis 图标、files 增加 icon.png
README.md             进化章节与目录更新
```多实例冒烟（2026-11-14）：SUPERAGENT_PORT=3083 + SUPERAGENT_HOME=.tmp/dsh-b 启动第二实例，
3083 编排 API 就绪（health 可读），数据目录 superagent-win-3083 独立生成；
默认实例 3082 同时 ready。测试后 B 已干净停止，A 保持运行。

## 7. 产品内使用引导（2026-11-14 追加）

- 「指南」页：新用户五分钟上手（双账号/接入/派活/工单/进化/多项目/FAQ）
- 接入向导第 5 步：协作者权限检测 + 一键 Write 邀请 + 接受邀请入口
- 会话页「接收已有议题」：停引擎→回拨 github-since 与观察流基线 7 天→起引擎，
  解决 bundle「不读开关之前旧消息」导致旧议题不被接收的问题

## 8. SSH 密钥库与等人行动条（2026-11-14 追加）

- test/ssh-vault.test.js 5/5：生成/加密落盘/分配注入/导入/删除/试连
- 全套 npm test 15/15
- 实机：密钥页生成→分配→GIT_SSH_COMMAND 注入→连接测试（见 shots/23-ssh.png）
- 工单 person/review 显示「等你评审合并」+ 打开 PR 按钮（shots/24-person-action.png）
