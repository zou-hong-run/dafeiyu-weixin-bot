# 开发约定

这是一份硬规则，不是建议。

## 一、改完必须跑

项目目前没有单元测试，靠语法检查和启动冒烟：

```bash
# 1. 所有文件语法（最快，能抓到括号和 import 拼写）
for f in $(find src -name "*.js"); do node --check "$f" || echo "FAIL: $f"; done

# 2. 模块能否加载（缺依赖、循环依赖在这里暴露）
DEEP_SEEK_API_KEY=test node --input-type=module -e "await import('./src/config/policy.js')"

# 3. 启动冒烟：跑到「长轮询中」就说明链路通了，Ctrl+C 退出
pnpm start
```

注意第 2 条别直接 import `src/index.js`——它会真的启动机器人。

## 二、纯逻辑改动应该补测试

这几块是可测的纯函数，改了要加 `tests/*.test.js`：

- `src/mcp-server/shell-guard.js` —— 命令归一化、绕过写法
- `src/config/policy.js` —— 权限判断、默认拒绝
- `src/ops/file-policy.js` —— 敏感路径黑名单
- `src/ops/activity.js` —— 闲置判断
- `src/chat/merge.js` —— 合并窗口
- `src/tasks/scheduler.js` —— cron 解析

现在还没有 `tests/` 目录。第一次加测试时用 `node --test`，并在 `package.json` 补上 `"test": "node --test \"tests/**/*.test.js\""`。

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

**`SELF.md` 是给机器人自己看的，每轮对话都会读进提示词。** 不同步它，机器人就会按旧认知说话——说"我做不到"、给出过时建议、或者压根不知道自己有新工具。这类错误比代码 bug 更难发现，因为它回答得很自信。

## 七、别把测试产物留在工作区

跑完测试、试完功能，`git status` 看一眼：

- `downloads/` 下的测试图片、音频、视频片段
- `data/` 下测试用的会话和工单
- `logs/` 里只为验证产生的内容

这些不进仓库（`.gitignore` 已经排除），但留在本地会混进真实数据。
