import fs from 'node:fs'
import path from 'node:path'
import { WeChatBot, stripMarkdown, MessageItemType } from '@wechatbot/wechatbot'
import { env } from '../config/env.js'
import { sdkLogger } from '../ops/logger.js'

// 微信 iLink 的适配层。
//
// 和 QQ 版 src/channel/qq.js 同一个职责：业务代码不直接依赖 SDK。
// 差异点集中在这一个文件里——
//   · 微信只有私聊，没有群聊 / 撤回 / 按钮 / markdown / 流式
//   · 收消息是长轮询，不是 WebSocket
//   · 每条回复必须带 context_token，SDK 用 reply() 自动管
//   · 文本 2000 字一段由 SDK 自己切，这里只负责剥 markdown

export const bot = new WeChatBot({
  storage: 'file',
  storageDir: env.loginDir,
  logger: sdkLogger,
  botAgent: 'wechat-deepseek-bot/0.1',
})

/** 消息段构造：形状沿用 QQ 版，业务代码换平台不用改 */
export const segment = {
  text: (text) => ({ type: 'text', data: { text: String(text ?? '') } }),
  image: (file) => ({ type: 'image', data: { file } }),
  file: (file, options = {}) => ({ type: 'file', data: { file, name: options.name } }),
  video: (file) => ({ type: 'video', data: { file } }),
}

// 外发文件上限。微信 CDN 能吃多大没说清，按保守值卡住，
// 大文件让模型先说明再决定，别让一次发送把内存吃满
const MAX_SEND_BYTES = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * 消息来源 → Buffer。
 * 支持三种：Buffer、项目内相对路径、http(s) 地址（现拉现发）。
 *
 * URL 统一在这里下载成 Buffer，而不是交给 SDK 的 { url }：
 * SDK 是按文件名猜类型的，带查询串或没有扩展名的链接会被发成「文件」，
 * 图片就变成附件而不是能直接看的图。
 */
async function readSource(source) {
  if (Buffer.isBuffer(source)) {
    if (source.length > MAX_SEND_BYTES) throw new Error(`超过 ${MAX_SEND_BYTES / 1048576}MB 上限`)
    return source
  }

  const text = String(source ?? '')
  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_SEND_BYTES) throw new Error(`下载后超过 ${MAX_SEND_BYTES / 1048576}MB 上限`)
    return buffer
  }

  const full = path.resolve(env.projectRoot, text)
  const buffer = fs.readFileSync(full)
  if (buffer.length > MAX_SEND_BYTES) throw new Error(`超过 ${MAX_SEND_BYTES / 1048576}MB 上限`)
  return buffer
}

/**
 * 业务层的 payload 转成 SDK 的 SendContent。
 * 微信不渲染 markdown，所以文本统一过一遍 stripMarkdown——
 * 不剥的话 `**加粗**` 会原样显示成星号。
 */
async function toContent(payload) {
  const parts = Array.isArray(payload) ? payload : [payload]
  let text = ''
  const media = []

  for (const part of parts) {
    if (part == null) continue
    if (typeof part === 'string') {
      text += part
      continue
    }
    if (part.type === 'text') text += String(part.data?.text ?? '')
    else if (part.type === 'image' || part.type === 'file' || part.type === 'video') media.push(part)
  }

  const caption = stripMarkdown(text).trim()

  if (media.length === 0) {
    if (!caption) throw new Error('消息内容为空')
    return caption
  }

  // 有媒体时一次只能带一个：SDK 的 SendContent 是单媒体形状，
  // 多条媒体按调用方拆成多次 dispatch（见 sendTo）
  const first = media[0]
  const source = first.data?.file
  if (first.type === 'image') return { image: await readSource(source), caption: caption || undefined }
  if (first.type === 'video') return { video: await readSource(source), caption: caption || undefined }
  return {
    file: await readSource(source),
    fileName: String(first.data?.name || path.basename(String(source ?? '')) || 'file'),
    caption: caption || undefined,
  }
}

/**
 * 发一条消息。
 * msg 是入站消息时走 reply（自动带 context_token）；
 * 没有入站上下文（定时推送之类）就按 userId 走 send，要求对方之前聊过。
 */
// 网络抖动值得重试：一次超时就放弃太脆。
// 但业务错误（prepare failed / invalid arguments）重试没用——那是请求本身被拒，
// 而且重试有让对方收到重复消息的风险，所以只重试连接类错误。
const RETRYABLE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|timeout/i

async function withRetry(task, attempts = 3) {
  let lastError
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? error)
      if (i === attempts || !RETRYABLE.test(message)) throw error
      console.warn(`[发送] 第 ${i} 次失败（${message.slice(0, 60)}），${400 * i}ms 后重试`)
      await sleep(400 * i)
    }
  }
  throw lastError
}

async function dispatch(payload, { msg, userId } = {}) {
  const content = await toContent(payload)
  if (!msg && !userId) throw new Error('没有 userId，也没有入站消息，发不出去')
  await withRetry(() => (msg ? bot.reply(msg, content) : bot.send(String(userId), content)))
}

/** 把 payload 拆成「正文」和「媒体项」 */
function splitPayload(payload) {
  const parts = Array.isArray(payload) ? payload : [payload]
  const text = parts
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.data?.text ?? ''))
    .join('')
  const media = parts.filter((part) => part && typeof part === 'object' && part.type !== 'text')
  return { text: text.trim(), media }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发出去。微信的 sendmessage 对一条消息里的 item 组合很挑：
 * 实测只要把图片和文字放进同一条就 `ret: -2 prepare failed`，
 * 一条消息里也带不了两个媒体。
 * 所以这里统统一条一个 item：媒体逐个发，正文最后单独发一条。
 */
async function deliver(payload, target) {
  const { text, media } = splitPayload(payload)

  if (media.length === 0) {
    if (!text) throw new Error('消息内容为空')
    return dispatch([segment.text(text)], target)
  }

  for (const [index, item] of media.entries()) {
    await dispatch(item, target)
    if (index < media.length - 1) await sleep(400)
  }

  if (text) {
    await sleep(400)
    await dispatch([segment.text(text)], target)
  }
}

/** 回一条 */
export function sendTo(event, payload) {
  return deliver(payload, { msg: event?.raw })
}

/** 主动发给某人：需要对方和你聊过（context_token 还在） */
export function sendToUser(userId, payload) {
  return deliver(payload, { userId })
}

/** 「正在输入」：微信协议要单独拿 typing_ticket，SDK 内部按用户缓存 24 小时 */
export function sendTyping(userId) {
  if (!userId) return Promise.resolve()
  return bot.sendTyping(String(userId)).catch(() => {})
}

/** 剥掉文本项里 SDK 顺手塞进来的 URL / 占位符，正文只留人真正打出来的字 */
function textOf(itemList) {
  const parts = []
  for (const item of itemList ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) parts.push(item.text_item.text)
  }
  return parts.join('\n').trim()
}

/** 附件描述，喂给 incoming.js 下载用 */
function inboundOf(itemList) {
  const items = []
  for (const item of itemList ?? []) {
    if (item.image_item) {
      items.push({ type: 'image', media: item.image_item.media, aeskey: item.image_item.aeskey, size: 0 })
    } else if (item.file_item) {
      items.push({
        type: 'file',
        media: item.file_item.media,
        name: String(item.file_item.file_name ?? ''),
        size: Number(item.file_item.len) || 0,
      })
    } else if (item.video_item) {
      items.push({ type: 'video', media: item.video_item.media, size: Number(item.video_item.video_size) || 0 })
    } else if (item.voice_item) {
      // 语音不下载：协议里平台给了转写文字就够用，音频解开也没有识别引擎
      items.push({ type: 'voice', text: String(item.voice_item.text ?? '') })
    }
  }
  return items
}

/**
 * IncomingMessage → 业务层的 event。
 * 字段名沿用 QQ 版（user_id / content / message），后续接工具和记忆时少改一处。
 */
export function toInternalEvent(msg) {
  if (!msg?.raw) return null
  // 机器人自己发的会被回推一遍，message_type 不是 USER 的直接丢
  if (msg.raw.message_type !== undefined && msg.raw.message_type !== 1) return null

  const raw = msg.raw
  const userId = String(msg.userId ?? raw.from_user_id ?? '')
  if (!userId) return null

  const messageId = String(raw.message_id ?? raw.client_id ?? raw.seq ?? `${raw.create_time_ms}-${userId}`)

  return {
    message_type: 'private',
    message_id: messageId,
    user_id: userId,
    user_openid: userId,
    content: textOf(raw.item_list),
    timestamp: msg.timestamp?.getTime?.() ?? (Number(raw.create_time_ms) || Date.now()),
    quoted: msg.quotedMessage ?? null,
    message: inboundOf(raw.item_list),
    raw: msg,
    reply: (payload) => dispatch(payload, { msg }),
  }
}

/** 统一的事件入口：业务层只注册一次 */
export function onMessage(handler) {
  bot.onMessage(async (msg) => {
    const event = toInternalEvent(msg)
    if (!event) return
    try {
      await handler(event)
    } catch (error) {
      console.error('[wechat] 处理消息失败：', error?.message ?? error)
    }
  })
}

/** 生命周期事件：登录、会话过期、轮询状态 */
export function onLifecycle({ login, expired, restored, error, close } = {}) {
  if (login) bot.on('login', (creds) => login(creds))
  if (expired) bot.on('session:expired', () => expired())
  if (restored) bot.on('session:restored', (creds) => restored(creds))
  if (error) bot.on('error', (err) => error(err))
  if (close) bot.on('close', () => close())
}

/** 扫码登录。凭证已存在时 SDK 会直接跳过 */
export function login(callbacks) {
  return bot.login({ callbacks })
}

export function start() {
  return bot.start()
}

export function stop() {
  bot.stop()
}

/** 当前登录状态，/diag 用 */
export function tokenStatus() {
  const creds = bot.getCredentials()
  if (!creds) return null
  return { userId: creds.userId, savedAt: creds.savedAt }
}

export function selfId() {
  return bot.getCredentials()?.userId ?? ''
}
