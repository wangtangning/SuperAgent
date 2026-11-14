# SuperAgent 指挥台（Windows）

一个 Windows 桌面宿主：**底座是 DeepSeek Harness（dsh）**，跑的是一套值守编排 bundle（Ticket / Policy / Source / Executor）。
宿主不重写业务，只做 Windows 上缺的那一层，并且把「人」这一端做成一个真正能用的入口。

> 这一版把「DSH 的 Web UI 装进窗口」改掉了：DSH 原生界面退到「引擎」页当高级视图，
> 日常用的四个面——概览、会话、工单、接入——都是宿主自己的界面，数据全部来自 bundle 的
> `/orchestrator/api`。**不复制业务，只做产品化。**

---

## 界面

| 页 | 做什么 |
| --- | --- |
| **概览** | 值守一句话状态、执行器负载、组件健康矩阵、最近决策、最近工单 |
| **会话** | 人 ↔ agent 的同一个入口：读取 bundle 的 thread / timeline，输入框直接回到议题里 |
| **工单** | 每个工单的阶段、执行器数量、工作目录、产出摘要，可重试 / 停止 |
| **进化** | 自我进化闭环：运行经验 → 失败分析 → 改进提案 → 验证应用 → 试用裁决（保留/回滚），详见 [docs/self-evolution.md](docs/self-evolution.md) |
| **接入** | GitHub 五步向导：gh → 账号 → 仓库 → 授权人 → 自检 |
| **设置** | 执行器目录与 prepare、宿主路径、宿主日志 |
| **引擎** | DSH 原生 Web UI（webview），排查问题时用 |

## 运行链路

```plain
Electron 宿主（electron/main.js）
  ├─ 确保 profile：%USERPROFILE%\.dsh\profiles\superagent（web 模板）
  ├─ 确保 bundle ：dsh plugin --profile superagent add link:…\bundle\dsh-superagent
  ├─ 子进程      : dsh --profile superagent --no-open   → 127.0.0.1:3082
  ├─ 就绪判定    : 拿到 dsh web URL + /orchestrator/api/state 真的能读
  ├─ 账号        : GitHub device flow（浏览器授权）→ %APPDATA%\superagent-win\gh-config
  └─ 窗口        : 概览 / 会话 / 工单 / 接入 / 设置 / 引擎
```

业务链：

```plain
GitHub 议题 @agent ──→ github-watch ──→ Policy 授权 ──→ Ticket
                                                   └─→ 每个 Ticket 一个 DSH 会话 / 一个目录 → PR / 回复
```

## GitHub 登录（不需要开终端）

1. 点「连接 GitHub」，宿主向 GitHub 申请一次性代码，**自动打开浏览器**的授权页；
2. 窗口里显示 `XXXX-XXXX`，可一键复制；
3. 你在浏览器里确认 → 宿主轮询到令牌 → 写入宿主自己的 `gh-config`（不动你系统里的 gh 配置）；
4. 之后「列出我的仓库」直接读你的仓库列表，选一个就行。

令牌用 Electron `safeStorage`（Windows DPAPI）加密后存在 `%APPDATA%\superagent-win\auth.json`。
宿主自己的 GitHub 操作（读账号、列仓库、回帖）都走 REST，不依赖 gh 二进制；
gh 只在 bundle 拉取议题 / 执行器干活时需要。

### gh 二进制

宿主会依次找：宿主安装目录 → 常见安装位置 → PATH。都没有时：

- 「下载并安装 gh」：从 GitHub Releases 拉 windows_amd64.zip，失败会依次尝试镜像；
- 「选择已有的 gh.exe」：已经装过的话直接指过去。

> 这台机器的网络只放行了 `github.com` / `api.github.com`，`objects.githubusercontent.com`
> （Releases 的 CDN）不通，所以自动下载会失败——这是网络问题，不是程序问题；
> 换网络后重试，或者用「选择已有的 gh.exe」。

## 启动

```bat
npm install
npm start
```

或双击 `启动.bat`。绿色版：`dist\win-unpacked\SuperAgent.exe`（重新打包见下）。

```bat
npm run dist
:: 产物 dist\SuperAgent <version>.exe（免安装）
```

若打包时下载超时，可设镜像后再试：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 稳定性处理

| 情况 | 处理 |
| --- | --- |
| 上一次被强杀，`%USERPROFILE%\.dsh\state\superagent.lock` 残留 | 启动前检测：端口没人听就清掉（否则 bundle 整个不激活，表现为 API 全 404） |
| 端口 3082 被占 | 启动前等待并提示；停止用 `taskkill /T` 清整棵进程树 |
| Web 端口起来了但 bundle 没激活 | 启动后额外校验 `/orchestrator/api/state`，失败给出明确错误 |
| 机器要靠本地代理才能访问 GitHub | 读 `HTTP(S)_PROXY` 环境变量，写到 Chromium 会话代理（Node 自带 fetch 不读代理） |
| 单实例 | `requestSingleInstanceLock` |

## 对 bundle 的改动

官方 `scripts/dsh-superagent start` 依赖 tmux / POSIX 脚本，Windows 上跑不起来；`stateDir` 的 schema
写死了 `^\ /`。这两处在 `bundle/dsh-superagent` 的产物里已经改好（源码两行）：

| 文件 | 改动 |
| --- | --- |
| `src/deployment.ts` | `stateDir` 绝对路径正则接受 `C:\…` / `C:/…` / UNC |
| `src/policy.ts` | Executor 的 `directory` 用 `path.isAbsolute()` 判断 |
| `src/sessions.ts` | 主会话 `tools.restrict` 的白名单按平台过滤（`tools.get(name, parent)`，与 worker 的 `workOnly` 同模式）：Windows 的 dsh 只注册 `pwsh` 没有 `bash`，硬编码 `bash` 会抛 unknown tool 导致整个 bundle 不激活 |

## 自我进化

值守会从自己的运行经验里学习：工单的合并/失败/重试记录被采集为经验，失败聚类自动变成
提示词教训、新技能或并发参数提案，经 bundle 原生版本化 API 验证落地（下一个工单立即生效），
再用后续真实工单的成功率裁决——改善则保留，退化则自动回滚。全程可在「进化」页观察与干预。

- 设计与运行方式：[docs/self-evolution.md](docs/self-evolution.md)
- 离线闭环测试：`npm test`
- 数据与证据：`%APPDATA%\superagent-win\evolution\`

## 目录

```plain
electron/main.js     宿主主进程（进程 / 就绪判定 / 本地 API 代理 / GitHub 登录 / 回帖）
electron/preload.js  contextBridge 白名单
electron/evolution/  自我进化引擎（经验采集 / 分析提案 / 应用回滚 / 编排，不依赖 Electron）
ui/                  指挥台界面（无框架，index.html + style.css + app.js）
bundle/dsh-superagent 内置的 bundle 产物
docs/                自我进化闭环设计文档
test/                进化引擎离线测试（node --test）
scripts/             cdp.js（读页面 DOM）、shot.js（截图）、make-icon.js（生成图标）
assets/ build/       图标源文件与产物（icon.svg / icon.png / icon.ico）
```
