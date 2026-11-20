# 开发约定

这是一份硬规则，不是建议。

## 一、改完必须跑

```bash
pnpm check   # 语法 + 模块加载 + 权限表自洽 + 单元测试（约 15 秒）
pnpm test    # 只跑单元测试
pnpm start   # 启动冒烟：跑到「长轮询中」就说明链路通了，Ctrl+C 退出
```

`pnpm check` 就是 `.github/workflows/ci.yml` 里跑的那一条，本地和线上一致。它会：
- 对 `src/` 和 `scripts/` 下所有 `.js` 跑 `node --check`
- 把每个模块 import 一遍（`src/index.js` 和 `scripts/` 除外——它们会真的执行）
- 校验权限表自洽：高危工具都有条目、白名单没和危险名单打架
- 跑 `tests/` 下的单元测试

**代码自动同步在推送前会先跑这条检查**，不过就不推。所以 `pnpm check` 红了连提交都进不了远端。

## 二、纯逻辑改动应该补测试

已有测试（改了对应模块要一起更新）：

| 文件 | 覆盖 |
|---|---|
| `tests/shell-guard.test.js` | 命令拦截：删根目录、读密钥、Windows 反斜杠、全角绕过 |
| `tests/policy.test.js` | 权限三档、SAFE_TOOLS 不误判、权限表完整性 |
| `tests/file-policy.test.js` | 敏感路径黑名单、路径穿越 |
| `tests/net-guard.test.js` | 内网/云元数据地址拦截、协议校验 |
| `tests/truncate.test.js` | 头尾保留、单行截断、落盘 |
| `tests/limiter.test.js` | 并发上限、排队、异常不占名额 |
| `tests/todos.test.js` | 清单状态、单 in_progress 约束、过期提醒 |
| `tests/activity.test.js` | 活跃度落盘、推送门控 |
| `tests/skills.test.js` | 技能读写、技能库检索 |
| `tests/schedule.test.js` | cron 校验、按会话隔离、创建者才能删、推送目标只能是自己 |

还值得补的：`src/chat/merge.js`（连发合并窗口）、`src/chat/compaction.js`（压缩后是否丢了关键结论）。

新加测试就放 `tests/<模块>.test.js`，`pnpm check` 会自动带上。

## 三、安全底线不许为了跑通而放宽

下面这些是安全边界，改动必须写清理由和攻击面：

| 文件 | 守的是什么 |
|---|---|
| `src/config/policy.js` | 高危工具的默认拒绝、白名单判定 |
| `src/ops/file-policy.js` | 敏感路径黑名单（`.env` `data/` `logs/` `backups/` `.ssh/`） |
| `src/ops/instance.js` | 单实例锁（两个进程同时轮询会互相吞消息） |
| `src/ops/permissions.js` | Linux 上收紧密钥和记忆文件的权限（700/600） |
| `src/mcp-server/shell-guard.js` | 危险命令拦截、敏感文件读取拦截 |
| `src/mcp-server/net-guard.js` | 出网地址校验（含 DNS 解析到内网） |
| `src/mcp-server/sandbox.js` | Linux 上的 bwrap 沙箱（可写目录只有 `tmp/`） |
| `src/mcp/client.js` | MCP 子进程的环境变量白名单 |
| `src/mcp/mcp-guard.js` | 外部 MCP 服务的启动命令白名单 |
| `src/mcp-server/evolve.js` | 装包强制 `--ignore-scripts`、注册表不存 env、新工具默认无权限 |

加例外的提交信息用 `security:` 开头，说明为什么需要放宽、放宽后最坏情况是什么。

## 四、平台限制不能靠改本地代码绕过

微信协议的限制在服务端，改本地代码绕不过去，只会让错误更难查：

- 图片不能和文字放同一条（服务端回 `prepare failed`），已自动拆条
- 一条消息只能带一个媒体
- 没有语音消息发送接口，音频只能当文件发
- `context_token` 会随会话放旧，主动发送要门控

遇到"发不出去"，先对照 [docs/PROTOCOL.md](docs/PROTOCOL.md) 看是不是踩了这几条，别急着改发送逻辑。

## 五、提交信息

中文，一句话说清「改了什么 + 为什么」。

```
feat: 加定时任务的活跃度门控，避免 token 过期白推
fix: 修正 yt-dlp 在 Windows 上输出中文乱码
security: shell 拦截 data/ 读取，之前 read_file 挡了但 shell 是后门
docs: 补 README 和协议说明
```

## 六、文档同步

改了下面这些，对应文档必须一起改：

| 改了什么 | 更新哪里 |
|---|---|
| **能力、工具、平台限制** | **`SELF.md`** |
| 命令、配置项、安装步骤 | `README.md` |
| 协议行为、错误码、平台坑 | `docs/PROTOCOL.md` |
| 安全机制、分层、数据流 | `docs/ARCHITECTURE.md` |
| 权限表、路径黑名单 | `docs/ARCHITECTURE.md` 的安全边界一节 |

**`SELF.md` 是基线，进仓库、所有人共享；个人设定写 `data/SELF.local.md`，git 不碰。**

**`SELF.md` 是给机器人自己看的，每轮对话都会读进提示词。** 不同步它，机器人就会按旧认知说话——说"我做不到"、给出过时建议、或者压根不知道自己有新工具。这类错误比代码 bug 更难发现，因为它回答得很自信。

## 七、别把测试产物留在工作区

跑完测试、试完功能，`git status` 看一眼：

- `downloads/` 下的测试图片、音频、视频片段
- `data/` 下测试用的会话和工单
- `logs/` 里只为验证产生的内容

这些不进仓库（`.gitignore` 已经排除），但留在本地会混进真实数据。
