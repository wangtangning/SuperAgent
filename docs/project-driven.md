# 项目驱动工作台 · 设计与对齐

> 状态：设计对齐稿 + 分阶段实现。Phase 1（项目框架/切换/添加向导）已实现；
> Phase 2（对接入口/推送管线）见文末路线。

## 你要的（原话整理）

1. 首页加项目面板，**项目框架切换，以项目驱动**；每个项目有自己整套页面。
2. 加入本地项目文件夹；决定是否上传 GitHub；可以**新建 GitHub 仓库承接本地项目**。
3. 对接方式：项目运行出问题 → 有渠道提问题 → 这边**自动修改 → 验收 → 推送**。
   推送既包括 GitHub，也包括**局域网本地服务器**。

## 对齐后的模型

```plain
项目 Project = 本地文件夹 + 可选 GitHub 仓库 + 可选部署目标(LAN) + 验收命令 + 对接入口
每个项目一个独立引擎实例（独立端口/DSH_HOME/userData），互不串数据；
指挥台是「项目框架」：左侧项目切换器，所有页面（概览/会话/工单/进化/接入/设置）都在当前项目上下文里。
```

### 项目生命周期

```plain
添加文件夹 → 探测(git? package.json? 运行方式?) → 可选: 新建GitHub仓库并首推
   → 配置: 验收命令 / 部署目标 / 对接入口 → 启动项目引擎 → 值守
问题进入(议题/webhook/日志监听/手动) → 工单 → worker 修改 → 验收命令跑通
   → 评审 agent 评审 → 合并推送 GitHub → 部署管线推 LAN → 健康检查 → 汇报
```

## 你没想到的，补齐清单

| # | 缺口 | 方案 |
| --- | --- | --- |
| 1 | **验收标准**：自动改完凭什么算好？ | 每项目配 `verify` 命令（npm test / 构建 / 自定义脚本）。worker 的 ready 报告必须附验收输出；评审 agent 把验收通过作为硬条件 |
| 2 | **本地-only 项目没有议题入口** | 宿主内置对接 HTTP 服务：`POST /hook/:projectId`（token 鉴权）+ 日志文件监听（错误模式命中→自动开单）+ 项目页「报问题」按钮 |
| 3 | **推 LAN 的方式** | 项目部署配置：目标服务器（来自服务器库）+ 方式（git pull / rsync-scp / 自定义命令）+ 重启命令 + 健康检查 URL；验收+评审通过后才执行 |
| 4 | **部署失败回滚** | 部署前在服务器留备份目录/记录旧 commit；健康检查失败自动回滚并开失败工单 |
| 5 | **密钥按项目隔离** | 服务器/SSH 库支持「项目可见性」标签；项目引擎只注入该项目可见的凭据 |
| 6 | **并发与资源** | 每项目引擎独立进程；项目面板显示运行状态，可单独启停；默认最多同时 3 个引擎，其余排队 |
| 7 | **分支/推送安全** | worker 永远在 `agent/<ticket>` 分支干活；合并走评审；直推 main 默认禁止 |
| 8 | **问题去重/防抖** | 日志监听同一错误模式 10 分钟内只开一单；webhook 带 fingerprint 去重 |
| 9 | **项目模板** | 探测 package.json → 建议 verify=`npm test`、run=`npm start`；无 git → 建议初始化 |
| 10 | **进化按项目隔离** | 进化数据已在各项目 userData 下，天然隔离；项目面板展示各项目成功率 |
| 11 | **首推大仓库** | 新建 GitHub 仓库时默认 private；首推前检查 .gitignore（node_modules/dist 不传）；LFS 提示 |
| 12 | **审计** | 项目页「推送/部署历史」：谁/何时/哪个工单/验收输出/部署结果，可回滚 |

## 数据模型

```jsonc
// %APPDATA%/superagent-win/projects.json
{ "activeId": "p-xxx",
  "projects": [{
    "id": "p-xxx", "name": "SuperAgent", "folder": "C:\\…\\SuperAgentWin",
    "repo": "wangtangning/SuperAgent",          // 可空=本地-only
    "port": 3082,                                // 引擎端口
    "home": "C:\\Users\\…\\.dsh",               // 引擎 DSH_HOME
    "verify": "npm test",                        // 验收命令
    "deploy": { "serverId": "s-xx", "mode": "git-pull|scp|command",
                "path": "/opt/app", "restart": "systemctl restart app",
                "health": "http://192.168.1.10:8080/health" },
    "intake": { "webhookToken": "…", "logWatch": { "file": "…", "pattern": "ERROR" } },
    "createdAt": "…"
  }] }
```

## Phase 1（已实现）

- 首页项目面板：卡片（名称/仓库/引擎状态/成功率）+「添加项目」
- 顶栏项目切换器：切换后所有页面进入该项目上下文（独立引擎/数据）
- 添加向导：选文件夹 → 探测 → 可选新建 GitHub 仓库（private，首推）→ 验收命令 → 完成
- 现有 SuperAgentWin 自动迁移为第一个项目

## Phase 2（路线）

- 对接 HTTP 服务 + 日志监听 → 自动开单（含去重）
- 验收硬条件接入评审 agent；部署管线（备份→推送→重启→健康→回滚）
- 凭据项目可见性；推送/部署历史与一键回滚