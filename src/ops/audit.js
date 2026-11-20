import { log } from './logger.js'

// 工具调用留痕。
//
// 三类都要记，尤其「被拒」——它是唯一能看出「有人在尝试越权」的信号。
// 只记成功的话，一次被拦下来的提权尝试在日志里完全不存在。
//
// 落盘走 logger（logs/bot-日期.log），所以事后能翻。

// 这些字段内容可能很长、也可能含敏感信息（写文件的内容、方案正文），
// 审计只需要知道「调了哪个工具、动到哪」，不需要把内容抄一遍
const SENSITIVE_FIELDS = new Set(['content', 'plan', 'text', 'code'])

function summarizeArgs(args) {
  if (args == null) return ''
  try {
    const copy = {}
    for (const [key, value] of Object.entries(args)) {
      if (SENSITIVE_FIELDS.has(key)) {
        copy[key] = `（${String(value ?? '').length} 字符，不记录内容）`
        continue
      }
      copy[key] = value
    }
    const text = JSON.stringify(copy)
    if (!text || text === '{}') return ''
    return ` ${text.length > 280 ? `${text.slice(0, 280)}…` : text}`
  } catch {
    return ''
  }
}

/**
 * @param {object} entry
 * @param {string} entry.name 工具名
 * @param {string} [entry.actor] 调用者（微信 userId）
 * @param {string} [entry.sessionKey] 会话键，工单/定时任务没有 actor 时用它定位
 * @param {object} [entry.args] 参数（会截断）
 * @param {'ok'|'denied'|'failed'} [entry.outcome]
 * @param {string} [entry.note] 附加说明，如拒绝原因
 */
export function auditTool({ name, actor = '', sessionKey = '', args, outcome = 'ok', note = '' } = {}) {
  const who = actor || sessionKey || 'unknown'
  const line = `[审计] ${outcome}｜${who}｜${name}${summarizeArgs(args)}${note ? `｜${note}` : ''}`

  if (outcome === 'denied') log.warn(line)
  else if (outcome === 'failed') log.warn(line)
  else log.info(line)
}

/** 发送文件/媒体单独记一笔：这是把本地东西往外送的通道 */
export function auditSend({ name, actor = '', sessionKey = '', source = '', outcome = 'ok', note = '' } = {}) {
  auditTool({
    name,
    actor,
    sessionKey,
    args: { source: String(source ?? '').slice(0, 200) },
    outcome,
    note,
  })
}
