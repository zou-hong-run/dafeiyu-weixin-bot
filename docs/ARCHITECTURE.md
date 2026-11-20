# 架构

## 分层

```
src/
├── channel/      微信协议适配：登录、长轮询、发送、附件
│   ├── wechat.js    SDK 包装：SDK 形状 ↔ 业务 event，发送拆条，失败重试
│   ├── sender.js    文本切段（按句号/换行切，不硬切）
│   └── incoming.js  附件下载解密、落盘、清理
├── chat/         对话与执行
│   ├── chat.js        一次问答：压缩记忆 → 装配提示词 → 工具循环
│   ├── agent.js       后台任务引擎：多轮工具、进度回调、验收
│   ├── tool-runner.js 工具执行层（权限 + 分流 + 审计），对话和工单共用
│   ├── local-tools.js 记忆类工具（直接读写 memory.json）
│   ├── media-tools.js 媒体发送工具（图片/文件/视频/音频）
│   ├── merge.js       连发合并
│   └── persona.js     人格
├── memory/       三层记忆（短期 / 摘要 / 长期）
├── mcp/          MCP 客户端：子进程管理、工具注册、调用与超时
├── mcp-server/   工具服务（独立 Node 子进程，24 个工具）
├── tasks/        工单与定时
│   ├── ticket.js      工单状态机，落盘可恢复
│   ├── worker.js      工单执行器
│   ├── scheduler.js   cron 调度、补跑、状态
│   ├── outbox.js      防重复推送
│   ├── heal.js        自愈节流（预留）
│   └── watchdog.js    巡检：卡住提醒、无效循环中止
├── ops/          运维基础
│   ├── logger.js      日志（控制台 + 按天落盘）
│   ├── audit.js       工具调用留痕（含被拒绝的）
│   ├── activity.js    活跃度台账（主动推送门控依据）
│   ├── instance.js    单实例锁（防两个进程同时轮询）
│   ├── permissions.js Linux 文件权限收紧（700/600）
│   ├── file-policy.js 敏感路径黑名单
│   ├── budget.js      按内存算能力上限
│   └── platform.js    平台差异探测
├── tenants/      多账号
│   ├── store.js       账号注册表（data/tenants/<id>/ 目录隔离）
│   └── manager.js     每个账号一个 client，负责启动/停止/扫码
├── web/          管理页面
│   ├── server.js      HTTP 服务、认证、二维码生成
│   └── page.js        页面（无构建，内联样式和脚本）
└── config/       env.js（配置）、policy.js（工具权限）
```

## 一条消息怎么变成回复

每个账号一个 client 实例，各自的长轮询和 context_token。消息进来时带 `tenantId` 和绑定好的 `send()`，回复从同一个实例原路发出去——不会串到别的账号。

```
长轮询 getupdates（每个账号各自一条）
  ↓  SDK 解析 + 缓存 context_token → event 带 tenantId 和 send()
handleEvent（src/index.js）
  ↓  去重 → 记活跃度 → 是命令吗？→ 工单在跑吗？
连发合并（merge.js，默认 2.5s 窗口）
  ↓
handleMessage
  ↓  附件下载解密（incoming.js）
chat()（chat.js）
  ↓  压缩溢出的历史 → 装配提示词 → 工具循环
工具调用（tool-runner.js）
  ↓  权限检查 → 本地 / 媒体 / MCP 分流 → 审计
sendReply（sender.js）
  ↓  按 900 字切段
deliver（wechat.js）
  ↓  媒体单独一条，正文另起一条
SDK reply（带回入站消息的 context_token）
```

提示词的组成，按顺序：

1. 人格（`persona.js`，或被 `SYSTEM_PROMPT` 覆盖）
2. 工具使用规矩（`chat.js` 的 `TOOL_RULES`）
3. **自我认知（`SELF.md`）**——按 mtime 缓存，改了下一轮生效
4. 中期摘要（历史溢出压出来的）
5. 最近 N 轮历史
6. 本轮输入（附件说明拼在正文后面，图片转 base64 进视觉通道）

### 工具结果截断

工具返回的内容进上下文前会过一遍 `src/chat/truncate.js`：

1. **单行截断**：单行超过 2000 字符就截（压缩过的 JSON、minified 代码经常一行几万）
2. **总量超限**：超过 4000 字符时，完整内容落盘到 `tmp/tool-output/<工具名>-<callId>.txt`
3. **给模型看的是**：开头 2600 + 结尾 700 + 落盘路径

保留结尾是关键——命令输出的最后几行常常就是报错或结果，只留开头等于把最重要的丢了。

`tmp/tool-output/` 在 `file-policy` 里被特批为可读（`SPILL_PREFIX` 例外），所以模型需要完整内容时能自己 `read_file` 翻回来。文件保留 24 小时，由每小时清理任务回收。

### 上下文压缩

历史超出 token 预算时（对话 60k、工单 40 条消息），把前面的内容压成一份「交接摘要」：

- 提示词来自 Kimi Code 的 `fullCompaction`，核心是**把压缩当成交接**——下一轮只能看到摘要和最近的消息
- 要求保留：具体数值、命令原文、文件路径、报错、已定结论与未决问题、还没查清的东西、后续计划、未验证的事项
- 多次压缩**增量合并**：旧摘要和新对话一起给模型，不覆盖
- 工单压缩时切分点必须落在消息边界，不能把 `tool` 消息和它的 `assistant(tool_calls)` 拆开
- 压缩失败时把原文放回历史（对话）或保留最近记录（工单），不丢内容

摘要存在 `data/memory.json` 的 `midTerm`，上限 4000 字。

## 工单流程

```
用户在微信发 /task <目标>
  ↓
startTask（worker.js）
  ├─ 检查并发（同一会话只能一个，全局受 TASK_CONCURRENCY 限制）
  ├─ createTicket → 落盘 data/tickets.json
  └─ 异步跑（不阻塞对话）
       ↓
     runTaskAgent（agent.js）
       ├─ 独立上下文：sessionKey = worker:<工单号>
       ├─ 每轮 onStep → 进度汇报（受间隔和条数限制）
       ├─ pullInput：用户中途说的话插进下一轮
       └─ notify_user 工具：中途主动说一句
       ↓
     验收（verifyCompletion）
       ├─ 通过 → finishTicket(done)
       └─ 没过 → 带上「验收意见」再跑一轮（最多 TASK_MAX_CONTINUATIONS 次）
       ↓
     最终汇报（完整结果）
```

巡检（`watchdog.js`）每 30 秒看一次运行中的工单：

- 超过 `TASK_STALL_SECONDS`（默认 5 分钟）没新动作 → 提醒
- 连续 4 次调同一个工具 → 判为无效循环，直接中止

## 定时任务流程

```
用户 /schedule <cron> <任务>
  ↓  addSchedule → data/schedules.json，记录 createdBy
scheduler tick（每 20 秒）
  ↓  cronMatches（用 cron-parser）
fire()
  ↓  runScheduledTask → runTaskAgent（actor = 创建者）
结果文本
  ↓  空或 SILENT → 不推送
活跃度门控（canPushTo）
  ↓  超过 PUSH_MAX_IDLE_MINUTES 没说话 → 放弃，记日志
sendMessage → sendToUser
```

补跑：进程没运行时错过的触发点，启动后 6 小时内补一次（同一个时间点只补一次）。

## 安全边界

六层，从外到内：

**1. 身份与授权**（`src/config/policy.js`）

高危工具（`shell` `run_script` `write_file` `edit_file` `clear_memory` `restart_self`）三档判定：

| 配置 | 效果 |
|---|---|
| 配了 `ADMIN_USER_IDS` | 只认名单 |
| 没配但 `ALLOW_DANGEROUS=true` | 全放行 |
| 都没配 | **默认拒绝** |

另外按工具名的能力词兜底（`write` `exec` `install` 等），防止以后注册进来的新工具默认开放。

**2. 工具执行与审计**（`src/chat/tool-runner.js`）

所有工具调用都过同一个函数：权限检查 → 分流 → 审计。**被拒绝的调用也记**，那是唯一能看出"有人在尝试越权"的信号。

审计写进 `logs/bot-日期.log`。

**3. 文件系统**（`src/ops/file-policy.js` + `fs-tools.js` 的 `resolveSafe`）

- 路径必须落在项目目录内
- 黑名单：`.env` `data/` `node_modules/` `.git/` `.ssh/` `backups/` `logs/` `tmp/`
- 读写都过同一份黑名单，避免"一处补了、另一处漏了"
- 例外：`tmp/tool-output/` 可读（工具输出落盘的地方）

**4. 命令执行**（`src/mcp-server/shell-guard.js`）

先把命令归一化（NFKC、去零宽字符、去引号、空白归一），再匹配——因为 `r''m`、`ｒｍ`、`r\m` 都能绕过单纯的正则。

拦截：
- 删根目录 / 用户主目录 / 项目外绝对路径
- fork 炸弹、关机、磁盘操作
- 读 `.env`、读 `data/` 下的记忆和凭证、读 SSH 密钥、读 `/etc/passwd`
- 导出环境变量、打印密钥变量
- 敏感路径 + 外传工具（curl/wget/scp）同时出现

工作目录（cwd）也必须在项目内。

**5. 网络**（`src/mcp-server/net-guard.js`）

- 只允许 http/https
- 拦内网地址段
- **解析 DNS 后再判一次**——挡「域名解析到 127.0.0.1」这种绕法
- 下载有大小上限，流式读取时超限当场中断

**6. 进程隔离**（`src/mcp/client.js`）

MCP 子进程只继承白名单环境变量（`PATH` `TEMP` `HOME` 等），模型 key 只给内置服务，第三方注册的服务拿不到。`NODE_OPTIONS` 显式排除——它能加载任意代码，绕过所有沙箱。

外部 MCP 服务的启动命令走白名单（`mcp-guard.js`）：只允许 `node` 和 `npx`，node 参数只认 `--max-old-space-size`，脚本必须落在项目 `tools/` 内，注册表热加载时重新校验。

### 平台限制

Windows 上没有 OS 级沙箱（bwrap 只有 Linux 有）。所以 shell 的隔离**完全靠上面这些规则**，没有内核级隔离兜底。这也是它默认关闭的原因。

## 数据文件

| 文件 | 内容 | 敏感 |
|---|---|---|
| `data/tenants/<id>/meta.json` | 账号名称、创建时间 | 否 |
| `data/tenants/<id>/ilink/credentials.json` | 该账号的 bot_token | **是** |
| `data/tenants/<id>/ilink/context_tokens.json` | 该账号的 context_token | **是** |
| `data/tenants/<id>/ilink/cursor.json` | 该账号的长轮询游标 | 否 |
| `data/instance.lock` | 单实例锁（进程 pid） | 否 |
| `data/memory.json` | 三层记忆（键是 `<tenantId>:user:<userId>`） | **是** |
| `data/tickets.json` | 工单状态和历史（含 tenantId） | 是 |
| `data/schedules.json` | 定时任务（含 target.tenantId） | 是 |
| `data/activity.json` | 各会话最后活跃时间 | 否 |
| `data/todos.json` | 各会话的任务清单（多步任务的进度） | 否 |
| `data/plans.json` | 规划模式下的方案（提交后等确认） | 否 |
| `data/music-cache.json` | 推过哪些歌（防重复） | 否 |
| `logs/bot-日期.log` | 运行日志 + 审计 | 是 |
| `downloads/` | 收发的文件 | 是 |

`data/` 整个目录都在 file-policy 黑名单里，模型读不到。备份和迁移时注意这些文件都是明文。

## 几个设计取舍

**为什么工具跑在独立子进程**
工具代码有 4000 行，还有大量动态 import（PDF/Word/Excel 解析库）。放主进程里，任一工具崩了或者吃内存，整个机器人跟着挂。子进程隔离后，工具服务挂了主进程还能降级成纯聊天。

**为什么本地工具不放进 MCP**
记忆类工具要直接读写主进程里的 `memory.json`，起子进程反而多一层同步问题。媒体发送需要当前会话的 `context_token`，也只能在主进程做。

**为什么对话和工单共用 `tool-runner`**
权限判断如果两处各写一遍，迟早漂移——一处补了、另一处漏了。所以权限、分流、审计全收在一个函数里。

**为什么主动推送要门控**
`context_token` 会放旧，硬推的结果是服务端拒绝、日志里一堆失败、用户什么都收不到。不如提前放弃并记一行日志，让人知道为什么没收到。
