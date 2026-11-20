import fs from 'node:fs'
import path from 'node:path'
import { WeChatBot, stripMarkdown, MessageItemType } from '@wechatbot/wechatbot'
import { env } from '../config/env.js'
import { log, sdkLogger } from '../ops/logger.js'

// 微信 iLink 的适配层。
//
// 每个租户（一个微信账号）创建一个实例，各自独立的凭证目录、轮询器和发送通道。
// 为什么必须是工厂而不是单例：SDK 的凭证按 storageDir 存，两个账号共用目录
// 会互相覆盖 context_token——A 的回复会发到 B 的会话里去。
//
// 微信协议的限制集中在这一个文件里：
//   · 只有私聊，没有群聊 / 撤回 / 按钮 / markdown / 流式
//   · 收消息是长轮询，不是 WebSocket
//   · 每条回复必须带 context_token，SDK 用 reply() 自动管
//   · 图片不能和文字放在同一条消息里（服务端 prepare failed）

/** 消息段构造：形状沿用 QQ 版，业务代码换平台不用改 */
export const segment = {
  text: (text) => ({ type: 'text', data: { text: String(text ?? '') } }),
  image: (file) => ({ type: 'image', data: { file } }),
  file: (file, options = {}) => ({ type: 'file', data: { file, name: options.name } }),
  video: (file) => ({ type: 'video', data: { file } }),
}

// 外发文件上限。微信 CDN 能吃多大没说清，按保守值卡住
const MAX_SEND_BYTES = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

// 网络抖动值得重试：一次超时就放弃太脆。
// 但业务错误（prepare failed / invalid arguments）重试没用——
// 那是请求本身被拒，而且重试有让对方收到重复消息的风险。
const RETRYABLE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|timeout/i

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 语音转写。平台已经把语音识别成文字了——那就是对方真正「说」的内容。
 * 加 [语音] 前缀是为了让模型知道来源，不然它会把对方说的话当成打出来的字。
 */
function spokenOf(itemList) {
  const parts = []
  for (const item of itemList ?? []) {
    if (item.type !== MessageItemType.VOICE) continue
    const text = String(item.voice_item?.text ?? '').trim().slice(0, 500)
    if (text) parts.push(`[语音] ${text}`)
  }
  return parts.join('\n').trim()
}

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
      // 有转写的已经当正文了，别再当成附件说一遍；
      // 没转写的才需要告诉模型「这条内容拿不到」（音频不下载，本机没有 SILK 解码）
      if (!String(item.voice_item.text ?? '').trim()) items.push({ type: 'voice', text: '' })
    }
  }
  return items
}

/**
 * 创建一个微信账号的客户端。
 * @param {{ tenantId: string, storageDir: string }} options
 */
export function createWechatClient({ tenantId, storageDir }) {
  const bot = new WeChatBot({
    storage: 'file',
    storageDir,
    logger: sdkLogger.child(`t:${tenantId}`),
    botAgent: 'wechat-deepseek-bot/1.0',
  })

  /**
   * 消息来源 → Buffer。
   * 支持 Buffer、项目内相对路径、http(s) 地址（现拉现发）。
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
      // 上层虽然校验过，这层也过一遍：readSource 是真正发起请求的地方，
      // 只靠调用方自觉的话，以后多一个调用点就多一个洞
      await assertPublicUrlResolved(text)
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

    // 有媒体时一次只能带一个：SDK 的 SendContent 是单媒体形状
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

  async function withRetry(task, attempts = 3) {
    let lastError
    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await task()
      } catch (error) {
        lastError = error
        const message = String(error?.message ?? error)
        if (i === attempts || !RETRYABLE.test(message)) throw error
        log.warn(`[发送:${tenantId}] 第 ${i} 次失败（${message.slice(0, 60)}），${400 * i}ms 后重试`)
        await sleep(400 * i)
      }
    }
    throw lastError
  }

  /**
   * 发一条消息。
   * msg 是入站消息时走 reply（自动带 context_token）；
   * 没有入站上下文（定时推送之类）就按 userId 走 send，要求对方之前聊过。
   */
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

  /**
   * 发出去。微信的 sendmessage 对一条消息里的 item 组合很挑：
   * 实测图片和文字放进同一条就 `ret: -2 prepare failed`，
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

  /** 回一条（用入站消息的 context_token） */
  function sendTo(event, payload) {
    return deliver(payload, { msg: event?.raw })
  }

  /** 主动发给某人：需要对方和你聊过（context_token 还在） */
  function sendToUser(userId, payload) {
    return deliver(payload, { userId })
  }

  /** 「正在输入」：微信协议要单独拿 typing_ticket，SDK 内部按用户缓存 24 小时 */
  function sendTyping(userId) {
    if (!userId) return Promise.resolve()
    return bot.sendTyping(String(userId)).catch(() => {})
  }

  /**
   * IncomingMessage → 业务层的 event。
   * 带 tenantId 和 send：上层不用知道是哪个账号、也不用全局单例。
   */
  function toInternalEvent(msg) {
    if (!msg?.raw) return null
    // 机器人自己发的会被回推一遍，message_type 不是 USER 的直接丢
    if (msg.raw.message_type !== undefined && msg.raw.message_type !== 1) return null

    const raw = msg.raw
    const userId = String(msg.userId ?? raw.from_user_id ?? '')
    if (!userId) return null

    const messageId = String(raw.message_id ?? raw.client_id ?? raw.seq ?? `${raw.create_time_ms}-${userId}`)

    const event = {
      tenantId,
      message_type: 'private',
      message_id: messageId,
      user_id: userId,
      user_openid: userId,
      // 打了字就用打的字；没打字（或只有语音）时，转写就是正文
      content: [textOf(raw.item_list), spokenOf(raw.item_list)].filter(Boolean).join('\n').trim(),
      timestamp: msg.timestamp?.getTime?.() ?? (Number(raw.create_time_ms) || Date.now()),
      quoted: msg.quotedMessage ?? null,
      message: inboundOf(raw.item_list),
      raw: msg,
    }

    event.reply = (payload) => dispatch(payload, { msg })
    event.send = (payload) => deliver(payload, { msg })
    return event
  }

  /** 统一的事件入口：业务层只注册一次 */
  function onMessage(handler) {
    bot.onMessage(async (msg) => {
      const event = toInternalEvent(msg)
      if (!event) return
      try {
        await handler(event)
      } catch (error) {
        log.error(`[wechat:${tenantId}] 处理消息失败`, { error: error?.message ?? String(error) })
      }
    })
  }

  /** 生命周期事件 */
  function onLifecycle({ login, expired, restored, error, close } = {}) {
    if (login) bot.on('login', (creds) => login(creds))
    if (expired) bot.on('session:expired', () => expired())
    if (restored) bot.on('session:restored', (creds) => restored(creds))
    if (error) bot.on('error', (err) => error(err))
    if (close) bot.on('close', () => close())
  }

  return {
    tenantId,
    storageDir,

    login: (callbacks) => bot.login({ callbacks }),
    start: () => bot.start(),
    stop: () => bot.stop(),
    onMessage,
    onLifecycle,

    sendTo,
    sendToUser,
    sendTyping,
    deliver,

    /** 下载并解密附件（incoming.js 用） */
    downloadRaw: (media, aeskey) => bot.downloadRaw(media, aeskey),

    /** 当前登录状态 */
    tokenStatus() {
      const creds = bot.getCredentials()
      return creds ? { userId: creds.userId, savedAt: creds.savedAt } : null
    },

    selfId() {
      return bot.getCredentials()?.userId ?? ''
    },
  }
}
