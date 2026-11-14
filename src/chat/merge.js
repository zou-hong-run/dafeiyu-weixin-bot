// 连发合并：同一个人在同一会话里连着发几段话，合起来当一次输入理解。
// 不加这个，用户「我有个问题」「关于昨天那个报错」「你帮我看看」连发三条，
// 机器人只会理解最后一条，前两句被当成两条独立对话各回一次。

const MAX_PARTS = 6
const MAX_CHARS = 1600

// 窗口不是固定值：正常打字 2~4 秒一句，固定 1.2 秒等于没开合并。
// 说完整了就快点回，像没说完就多等一会儿。
const MIN_WINDOW = 800
const LONG_FACTOR = 1.6
const MAX_WAIT = 7000

const slots = new Map()

function keyOf(sessionKey, userId) {
  return `${sessionKey}\u0000${userId || ''}`
}

function flush(key, entry, handler) {
  slots.delete(key)
  clearTimeout(entry.timer)
  handler({
    sessionKey: entry.sessionKey,
    userId: entry.userId,
    events: entry.events,
    text: entry.texts.join('\n'),
  })
}

/** 按这段话判断该等多久 */
function windowFor(text, base) {
  const value = String(text ?? '').trim()
  if (!value) return base

  // 有句末标点、或者本身够长：话已经说完了，别拖着
  if (value.length >= 15 || /[。！？!?；;…]$/.test(value)) return Math.min(base, MIN_WINDOW)

  // 短句、或者以「帮我 / 一下 / 吗 / 呢」结尾：多半还有下一句，多等一会儿
  if (value.length <= 12 || /(一下|看看|看下|查下|呗|呢|吗|帮我|请问|怎么样)$/.test(value)) {
    return Math.max(base, base * LONG_FACTOR)
  }

  return base
}

/**
 * 把一条消息丢进合并槽。窗口内没新消息就合并成一次处理。
 * @param {{ sessionKey: string, userId?: string, text?: string, event: object, windowMs?: number, maxChars?: number, immediate?: boolean }} input
 * @param {(batch: { events: object[], text: string }) => void} handler
 */
export function mergeMessage(
  { sessionKey, userId = '', text = '', event, windowMs = 2500, maxChars = MAX_CHARS, immediate = false },
  handler,
) {
  const body = String(text ?? '').trim()
  const key = keyOf(sessionKey, userId)
  const existing = slots.get(key)

  // 命令、空消息、超长、带附件的都不合并：先把攒着的冲出去，再单独处理这条，顺序不会乱
  if (immediate || !body || body.startsWith('/') || body.length > maxChars) {
    if (existing) flush(key, existing, handler)
    handler({ sessionKey, userId, events: [event], text: body })
    return
  }

  if (!existing) {
    const entry = { events: [], texts: [], timer: null, sessionKey, userId, firstAt: Date.now() }
    slots.set(key, entry)
    queue(key, entry, body, event, windowMs, maxChars, handler)
    return
  }

  queue(key, existing, body, event, windowMs, maxChars, handler)
}

function queue(key, entry, body, event, windowMs, maxChars, handler) {
  entry.events.push(event)
  entry.texts.push(body)

  // 攒太多就别再等了，立刻冲
  const total = entry.texts.join('\n').length
  if (entry.events.length >= MAX_PARTS || total >= maxChars) {
    flush(key, entry, handler)
    return
  }

  // 从第一条算起最多等 MAX_WAIT，别让用户一直等着它攒
  const elapsed = Date.now() - entry.firstAt
  const wait = Math.min(windowFor(body, windowMs), Math.max(0, MAX_WAIT - elapsed))

  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => flush(key, entry, handler), wait)
  entry.timer.unref?.()
}

/** 清掉某个会话还在等的合并批次（/reset 时用，别再把这些话拼进去） */
export function clearMerged(sessionKey) {
  const prefix = `${sessionKey}\u0000`
  let removed = 0
  for (const [key, entry] of slots) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(entry.timer)
    slots.delete(key)
    removed += 1
  }
  return removed
}

/** 清掉所有还在等的合并批次（进程退出时用，顺便知道丢了几批） */
export function clearAllMerged() {
  let removed = 0
  for (const [, entry] of slots) {
    clearTimeout(entry.timer)
    removed += 1
  }
  slots.clear()
  return removed
}

/** 进程退出或该会话关闭时，把攒着的立刻交出去，别丢消息 */
export function flushMerged(handler) {
  for (const [key, entry] of slots) {
    flush(key, entry, handler)
  }
}
