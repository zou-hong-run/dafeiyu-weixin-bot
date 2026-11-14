# 微信 iLink 协议笔记

微信 ClawBot 背后的 HTTP/JSON 接口，基址 `https://ilinkai.weixin.qq.com`，媒体 CDN 在 `https://novac2c.cdn.weixin.qq.com/c2c`。

官方说明：[wechatbot.dev/zh/protocol](https://www.wechatbot.dev/zh/protocol)。这份文档只记**官方没写、我们实测出来的**部分。

## 三个阶段的概览

| 阶段 | 接口 | 说明 |
|---|---|---|
| 登录 | `GET /get_bot_qrcode`、`GET /get_qrcode_status` | 二维码扫码，状态机 `wait → scaned → confirmed`（或 `expired`） |
| 收消息 | `POST /getupdates` | 长轮询，服务端挂起约 35 秒；返回 `get_updates_buf` 游标 |
| 发消息 | `POST /sendmessage` | 必须带 `context_token` |
| 输入状态 | `POST /getconfig`、`POST /sendtyping` | 先拿 `typing_ticket`，再发送 |
| 媒体 | `POST /getuploadurl`、CDN `/upload` | AES-128-ECB 加密 |

每个业务请求都要带：

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: base64(String(random_uint32))   ← 每次重新生成
```

请求体统一带 `base_info: { channel_version }`。

## context_token：最容易踩的坑

这是把回复路由回正确会话的凭据。规则：

1. 每条入站消息都带一个 `context_token`
2. 每条出站 `sendmessage` 必须原样回传
3. 按 userId 缓存，**每个用户只保留最新一个**

发送有两条路径，用的 token 不同：

| 路径 | 用的 token | 会失效吗 |
|---|---|---|
| 回复（`bot.reply(msg, ...)`） | 当前入站消息自带的那个 | 不会，永远是新鲜的 |
| 主动发送（`bot.send(userId, ...)`） | 缓存表里那份（落盘 `data/ilink/context_tokens.json`） | **会**，放久了服务端拒绝 |

### 实测现象

- 主动发送依赖的 token 放久之后，`sendmessage` 开始回 `ret: -2, errmsg: "prepare failed"`
- 让用户发一条消息（拿到新 token）后立刻恢复
- 具体是「一次性」「有时效」还是「绑定服务端会话状态」，**协议文档没写，我们没查清**

这也是为什么所有主动推送都要过活跃度门控（`PUSH_MAX_IDLE_MINUTES`，默认 30 分钟）——推之前先看对方多久没说话了。

## 消息内容的结构限制

一条消息是 `item_list` 数组，每个 item 有类型：`text(1)` `image(2)` `voice(3)` `file(4)` `video(5)`。

**实测结论**（同一个有效 token 下做的对照实验）：

| 组合 | 结果 |
|---|---|
| 只有图片 | ✅ 成功 |
| 文字 + 图片 | ❌ `prepare failed` |
| 图片 + 文字 | ❌ `prepare failed` |
| 只有文件 | ✅ 成功 |
| 文件 + 文字 | ⚠️ 没测准（当时 token 已过期），按不行处理 |

所以当前实现是**一条消息只放一个 item**：媒体逐个单独发，正文最后另起一条。发送层见 `src/channel/wechat.js` 的 `deliver()`。

代价是「发图 + 说明」会变成两条消息。这是协议决定的，不是实现偷懒。

### 文本分段

SDK 内部按 2000 字切分，切点优先段落、换行、空格。我们在上层又按 `REPLY_MAX_CHARS`（默认 900）先切一遍——一次写三千字在手机上就是一大坨。

## 媒体

CDN 上的所有媒体都是 AES-128-ECB + PKCS7 加密，密钥有三种编码格式（raw base64 / hex 字符串的 base64 / 直接 hex），SDK 都支持。

加密后大小：`ceil((rawSize + 1) / 16) * 16`。

上传流程：`getuploadurl` 拿参数 → 加密 → CDN `POST /upload` → 从响应头 `x-encrypted-param` 拿引用。

## 错误码

| 码 | 含义 | 我们的处理 |
|---|---|---|
| `ret: 0` | 成功 | — |
| `ret: -2` | 参数错误，常见于 `prepare failed`（item 组合不合法或 token 失效） | 不重试，转成文本告诉模型 |
| `errcode: -14` | 会话过期 | SDK 自动重新登录 |
| HTTP 4xx | 认证失败 | 检查 token |
| HTTP 5xx | 服务端错误 | 网络类重试 3 次，递增间隔 |

发送重试只针对连接类错误（`ECONNRESET` `ETIMEDOUT` `ENOTFOUND` 等）。业务错误重试没用，还可能让对方收到重复消息。

## 语音只能收不能发

- **收**：`voice_item.text` 是平台转写的文字。**转写就是对方说的话，我们当正文用**（加 `[语音]` 前缀标明来源），不下载音频——本机没有 SILK 解码，拉下来也解不出字。
- **转写失败**：`voice_item.text` 为空，这时把语音项放进「附件」数组，让模型知道这条内容拿不到，由它去说「没听清，你打字说一遍」。不要猜内容，也不要说成「文件已收到」。
- **发**：协议有 `MediaType.VOICE`，上传层也支持，但 SDK 的 `MessageBuilder` 没有 `voice()` 方法，没有发送封装

所以 `send_audio` 的实现是：下载 → ffmpeg 转 mp3 → 当**文件**发。对方点开能播放，但形式是文件不是语音气泡。

## 平台能力的边界

- **纯单聊**：bot_token 在开通时就绑定了扫码的那个微信号，`from_user_id` 永远只会是扫码者。机器人不是微信联系人实体——没有名片、没有可搜索的微信号、没有加好友流程，协议里也没有"被发现"的接口。第二个用户从设计上触达不到它。
- **不能进群**：官方明确「仅支持个人单点使用」
- **没有撤回**：协议里没有这个接口

## 我们踩过的坑

**Windows 上 yt-dlp 输出中文乱码**
yt-dlp 是 Python 程序，默认按系统代码页（936）输出，Node 按 UTF-8 解码就成方块。解法：调用参数加 `--encoding utf-8`。别改成依赖终端环境变量，那个不稳定。

**B 站给的是分离的音视频流**
没有能直接播的单文件 mp4，直链发出去是无声的。`find_video` 会明确报错并建议用 `fetch_video` 截片段。

**B 站字幕要登录态**
没有 `data/cookies.txt` 就读不到。`read_video_subtitle` 会说明原因，不要以为是自己写错了。

**`video_meta` 返回过 `[object Object]`**
MCP 层把 handler 返回值统一 `String()` 了，而它返回的是结构化对象。现在改成对象走 JSON 序列化（`src/mcp-server/index.js`），`video_meta` 自己也改成返回可读文本。

**SDK 的 `{ url }` 会按文件名猜类型**
带查询串或没扩展名的链接会被发成「文件」而不是图片。所以 `src/channel/wechat.js` 的 `readSource()` 统一自己下载成 Buffer，类型由调用方指定。
