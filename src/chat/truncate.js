import fs from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// 工具结果截断。
//
// 策略搬自 Kimi Code 的 agent/toolResultTruncation：
//   1. 单行超长先截断——压缩过的 JSON、minified 代码经常一行几万字符
//   2. 总长度超限时把完整内容落盘，模型只看到「开头 + 结尾 + 文件路径」
//   3. 落盘失败就只给首尾预览，并明说存不下
//
// 关键差别是**保留尾部**。我们原来只留前 4000 字，而命令输出的最后几行
// 往往正是报错和结果——把最重要的部分丢了。
//
// 落盘位置用 tmp/tool-output/：file-policy 里对这个前缀特批了「可读」，
// 模型需要完整内容时能用 read_file 自己翻。

const LIMIT = 4000 // 给模型的文本上限
const HEAD = 2600 // 开头预览
const TAIL = 700 // 结尾预览
const MAX_LINE = 2000 // 单行上限
const SPILL_DIR = 'tmp/tool-output'
const SPILL_TTL_HOURS = 24

/** 单行超长就截断。一行 10 万字符的 JSON 塞进去，上下文直接爆 */
function shapeLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 14)}…[本行已截断]`,
    )
    .join('\n')
}

function safeName(toolName, callId) {
  return `${toolName || 'tool'}-${callId || Date.now()}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'tool-result'
}

/**
 * @param {string} text 工具返回的文本
 * @param {{ toolName?: string, callId?: string }} meta 用于命名落盘文件
 * @returns {string} 可以塞进上下文的内容
 */
export function truncateToolResult(text, { toolName = '', callId = '' } = {}) {
  const raw = String(text ?? '')
  if (!raw) return ''

  const shaped = shapeLines(raw)
  if (shaped.length <= LIMIT) return shaped

  // 完整内容（含未截断的行）落盘，模型需要时自己读
  const rel = path.join(SPILL_DIR, `${safeName(toolName, callId)}.txt`).split(path.sep).join('/')
  const abs = path.join(env.projectRoot, rel)

  let saved = false
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, raw, 'utf8')
    saved = true
  } catch {
    saved = false
  }

  const head = shaped.slice(0, HEAD)
  const tail = shaped.slice(-TAIL)
  const omitted = Math.max(0, shaped.length - HEAD - TAIL)

  const note = saved
    ? `完整内容 ${raw.length} 字符已存到 ${rel}，需要时用 read_file 分页读，或用 shell 的 grep 搜`
    : '完整内容没能存下来（写盘失败），下面只有首尾预览，看不到的部分不要猜'

  return [
    `（工具输出 ${raw.length} 字符，超过 ${LIMIT} 上限，只给了首尾）`,
    note,
    '',
    '[开头]',
    head,
    '',
    `[中间省略 ${omitted} 字符]`,
    '',
    '[结尾]',
    tail,
  ].join('\n')
}

/** 清理过期的落盘文件。跟入站附件一样按 mtime 扫，别让 tmp 无限涨 */
export function cleanupSpill(ttlHours = SPILL_TTL_HOURS) {
  if (!(ttlHours > 0)) return 0

  const dir = path.join(env.projectRoot, SPILL_DIR)
  const ttlMs = ttlHours * 3600 * 1000
  const now = Date.now()
  let removed = 0

  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    try {
      if (now - fs.statSync(full).mtimeMs <= ttlMs) continue
      fs.rmSync(full, { force: true })
      removed += 1
    } catch {
      // 单个删不掉不影响其他
    }
  }

  return removed
}
