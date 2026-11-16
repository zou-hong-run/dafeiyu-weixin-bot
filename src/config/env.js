import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defaultEnvFile } from '../ops/platform.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 密钥优先从项目外读（Linux 上是 /etc/wechatbot/env，或用 APP_ENV_FILE 指定），
// 项目根的 .env 只做兜底。这样即使项目目录被 web 服务或静态托管暴露，
// 也拿不到 API key 和登录凭证。
const externalEnv = process.env.APP_ENV_FILE?.trim() || defaultEnvFile()
config({ path: [externalEnv, path.join(projectRoot, '.env')], quiet: true })

function positiveNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(name, fallback) {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const apiKey = (process.env.DEEP_SEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? process.env.API_KEY ?? '').trim()

if (!apiKey) {
  console.error('[配置] 缺少环境变量：DEEP_SEEK_API_KEY')
  console.error('       请在 .env 中补齐后重新启动。')
  process.exit(1)
}

const customPrompt = process.env.SYSTEM_PROMPT?.trim()

export const env = {
  projectRoot,

  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
  // deepseek-flash 原生支持图片理解，发图会走视觉通道
  model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',

  systemPrompt: customPrompt || '',

  // 短期记忆保留多少轮（一问一答算一轮）
  historyTurns: Math.floor(positiveNumber('HISTORY_TURNS', 10)),
  maxInputChars: Math.floor(positiveNumber('MAX_INPUT_CHARS', 1000)),
  replyMaxChars: Math.floor(positiveNumber('REPLY_MAX_CHARS', 900)),
  maxOutputTokens: Math.floor(positiveNumber('MAX_OUTPUT_TOKENS', 4096)),
  // 一轮对话最多调几轮工具：太多会把额度和上下文一起吃穿
  maxToolRounds: Math.floor(positiveNumber('MAX_TOOL_ROUNDS', 8)),
  toolTimeoutMs: positiveNumber('TOOL_TIMEOUT_SECONDS', 60) * 1000,

  // 后台工单
  taskMaxRounds: Math.floor(positiveNumber('TASK_MAX_ROUNDS', 20)),
  // 验收不过时自动续跑几轮；设 0 关掉
  taskMaxContinuations: Math.floor(nonNegativeNumber('TASK_MAX_CONTINUATIONS', 2)),
  taskConcurrency: Math.floor(positiveNumber('TASK_CONCURRENCY', 2)),
  taskReportInterval: positiveNumber('TASK_REPORT_INTERVAL', 60) * 1000,
  taskMaxReports: Math.floor(positiveNumber('TASK_MAX_REPORTS', 3)),
  taskStallMs: positiveNumber('TASK_STALL_SECONDS', 300) * 1000,

  // 连发合并窗口：他连着发几句就合成一次理解。0 = 关闭
  mergeWindowMs: nonNegativeNumber('MERGE_WINDOW_MS', 2500),

  // 主动推送最多容忍多久没说话（分钟）。超过就认为 context_token 已旧，不推
  pushMaxIdleMinutes: positiveNumber('PUSH_MAX_IDLE_MINUTES', 30),

  // 高危工具白名单（接工具系统后用）
  adminUserIds: (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // 没配白名单时，是否仍然放行高危工具。默认 false：
  // 「没配置」不该等于「全放开」，要开就得明确写一句话
  allowDangerous: process.env.ALLOW_DANGEROUS === 'true',

  toolDebug: process.env.TOOL_DEBUG === 'true',
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',

  // 收到的图片/文件留多久（小时），到点自动删
  mediaTtlHours: positiveNumber('MEDIA_TTL_HOURS', 24),

  // 扫码登录在终端里画二维码用
  loginDir: path.join(projectRoot, 'data', 'ilink'),

  // 多账号管理页面。默认只听本机——要外部访问必须自己配 token。
  webEnabled: process.env.WEB_ENABLED !== 'false',
  webHost: process.env.WEB_HOST?.trim() || '127.0.0.1',
  webPort: Math.floor(positiveNumber('WEB_PORT', 8848)),
  webAccessToken: process.env.WEB_ACCESS_TOKEN?.trim() || '',

  // 最多接多少个微信账号。每个账号一条长轮询连接 + 一份运行时状态，
  // 主要吃内存和文件句柄。默认 20 是保守值，机器内存大可以调高。
  maxTenants: Math.floor(positiveNumber('MAX_TENANTS', 20)),
}
