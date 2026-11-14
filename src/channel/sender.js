import { env } from '../config/env.js'
import { segment, sendTo } from './wechat.js'

// 出站文本：切段 + 发送。
// 微信单条消息上限比 QQ 宽（SDK 内部按 2000 字切），但一次写三千字在手机上
// 就是一大坨。这里按 replyMaxChars 主动切，切点优先落在段落和句号上。

export function clip(text, max = env.replyMaxChars) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/**
 * 切段：先按空行切段落，段落还超长再按换行、句号切。
 * 不用固定长度硬切——那会把链接和列表劈成两半。
 */
export function splitText(text, max = env.replyMaxChars) {
  const source = String(text ?? '').trim()
  if (!source) return []
  if (source.length <= max) return [source]

  const parts = []
  let rest = source

  while (rest.length > max) {
    // 在窗口内找最靠后的自然切点
    const window = rest.slice(0, max)
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('. '),
    )

    const at = cut > max * 0.4 ? cut + 1 : max
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }

  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

/** 回一条。超长自动切成几条，段间留一点间隔，别像刷屏 */
export async function sendReply(event, text) {
  const parts = splitText(text)
  if (parts.length === 0) return

  for (const [index, part] of parts.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 500))
    await sendTo(event, [segment.text(part)])
  }
}
