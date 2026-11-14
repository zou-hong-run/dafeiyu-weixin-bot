# v1.0.0 · 2026-11-14

首个完整可用版本。从零搭起的一条新链路，不是从 QQ 版整包移植——只搬了平台无关的部分（工具服务、工单、定时调度、记忆），协议层和安全层按微信的场景重写。

## 它是什么

跑在自己电脑上的微信私聊助手。扫码登录后，通过微信单聊就能用：联网查资料、读写文件、发图发歌、解析视频、把长任务丢到后台跑、按 cron 定时干活。

基于微信官方 iLink Bot 协议（微信 ClawBot 背后的接口），SDK 用 `@wechatbot/wechatbot`。

**只有扫码的那个人能用**，别人加不了，也进不了群——协议层绑定的。

## 这个版本有什么

### 对话与记忆

- 接 DeepSeek（默认 `deepseek-flash`，支持看图）
- 三层记忆：短期（最近 N 轮）、中期（溢出自动压成摘要）、长期（`remember` 写的永久事实）
- 连发合并：连着发几句合成一次理解，窗口会随句子完整性自动调整
- 人格设定，说话有自己的腔调，不是客服腔

### 工具

**24 个 MCP 工具**（独立子进程，主力不在主进程里）：

联网 `search` `fetch` `download`；查询 `now` `weather` `exchange` `timezone` `dns` `system_info`；计算 `calc`；文件 `read_file` `list_dir` `read_document` `write_file` `edit_file`；执行 `shell` `run_script` `restart_self`；媒体 `draw_pixel` `find_music`；视频 `find_video` `fetch_video` `video_meta` `read_video_subtitle`。

**9 个本地工具**：记忆 5 个 + 发送 4 个（`send_image` `send_file` `send_video` `send_audio`）。

`read_document` 能读 PDF / Word / Excel；`find_music` 走 iTunes 曲库拿 30 秒试听；视频解析靠 yt-dlp。

### 媒体

收发双向都通：文本、图片、文件、视频、音频。

- **收语音**：平台自动转写，转写当正文用（带 `[语音]` 前缀标明来源）
- **发音频**：微信没有语音消息接口，音频会下载后转成 mp3 当文件发，对方点开能播
- 图片 + 说明文字会自动拆成两条——协议不允许放同一条

### 后台工单

`/task <要做的事>` 丢到后台跑，不阻塞对话：

- 独立上下文，不污染日常聊天
- 中途汇报进度（受间隔和条数限制，不刷屏）
- 你插的话会转给工单
- 每轮结束自动验收，没通过就带着意见再跑一轮
- 巡检盯着：卡住 5 分钟提醒，连续 4 次调同一工具判无效循环直接中止

### 定时任务

`/schedule <cron> <任务>`，标准五段 cron。支持补跑（进程没运行时错过的点，启动后 6 小时内补一次）。

推送前有活跃度门控——太久没说话时 `context_token` 会失效，宁可提前放弃并记日志，也不做无声的失败。

### 安全

六层边界，默认最小权限：

1. 高危工具默认关闭（配 `ADMIN_USER_IDS` 或 `ALLOW_DANGEROUS=true` 才开）
2. 所有工具调用过统一权限层，**被拒绝的也写审计日志**
3. 文件读写限制在项目内，`data/` `.env` `logs/` `backups/` `.git/` `.ssh/` 全黑名单
4. 命令归一化后匹配，挡删根目录、读密钥、导出环境变量、敏感路径 + 外传工具组合
5. 出网过地址校验，DNS 解析到内网也挡
6. MCP 子进程只继承白名单环境变量

## 已知限制

都是协议层面，改代码绕不过去：

- 只有私聊，没群聊，不能被拉进群
- 发不了语音消息（音频只能当文件发）
- 没有撤回
- 微信不渲染 markdown，发送前剥掉格式符号
- 图片和文字不能放同一条消息
- 一条消息只能带一个媒体
- 主动推送依赖 `context_token`，放久了失效

## 上手

```bash
pnpm install
cp .env.example .env      # 填 DEEP_SEEK_API_KEY
pnpm start                # 扫终端里的二维码
```

可选依赖：`yt-dlp`（解析视频）、`ffmpeg`（音频转码、视频合并）。不装的话对应功能报错，其他照常。

## 验证情况

**已验证**

- 语法全部通过，28 个模块加载成功，MCP 服务 24 个工具就绪
- 真实扫码登录、长轮询收消息、对话回复
- 真实调用：`now` / `remember` / `shell`（授权后）/ `calc` / `find_music` / `video_meta` / `fetch_video` / `send_image` / `send_video` / `send_audio`
- 权限三档判定、审计落盘、敏感路径拦截、shell 命令拦截（含 Windows 反斜杠绕过写法）
- 工单真实跑通（4 秒完成一个计算任务，结果正确）
- 定时任务增删查、cron 解析
- 语音转写的五种组合（纯语音 / 无转写 / 文字+语音 / 多条语音 / 文字+图片）

**没有验证到的**

- **没有单元测试**。纯逻辑模块（shell-guard、policy、file-policy、merge、cron 解析）都值得补，`AGENTS.md` 里列了清单
- **定时推送的门控效果没实测**。`context_token` 到底能撑多久我们没查清，只观察到「放久会被拒、发条消息就恢复」
- 部分功能依赖外部程序（yt-dlp / ffmpeg），换机器要重新确认

## 升级说明

首个版本，没有升级路径要处理。
