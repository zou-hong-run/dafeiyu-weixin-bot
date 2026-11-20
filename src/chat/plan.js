import fs from 'node:fs'
import { paths } from '../config/paths.js'
import { log } from '../ops/logger.js'
import path from 'node:path'
import { env } from '../config/env.js'

// 规划模式（Plan mode）。
//
// 语义搬自 Kimi Code 的 features/plan：进入后只能读，把方案写出来让人过目，
// 批准了才动手。它那边靠 IDE 的审批面板，我们这边就是「发给对方，等他回『执行』」。
//
// 为什么值得有：复杂任务直接开干，做错方向要重来；先给方案，成本低得多。
// 而且规划阶段不给写权限，模型没法「边做边改主意」。

const dataDir = paths.data
const planFile = path.join(dataDir, 'plans.json')

// 规划阶段允许用的工具：全部只读，加上提交计划的出口。
// 这个白名单是硬的——写文件、执行命令、发消息一个都不给，
// 免得模型「规划」到一半顺手把事做了。
export const PLAN_MODE_TOOLS = new Set([
  'search',
  'fetch',
  'now',
  'calc',
  'weather',
  'exchange',
  'timezone',
  'dns',
  'system_info',
  'read_file',
  'list_dir',
  'read_document',
  'recall_memory',
  'list_memory',
  'exit_plan_mode',
])

/**
 * 按会话存：
 *   { "<sessionKey>": { task, content, submittedAt, createdAt } }
 * content 是模型提交的方案正文，submittedAt 有值表示「方案已提交、等批准」。
 */
let state = {}

try {
  const raw = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  if (raw && typeof raw === 'object') state = raw
} catch {
  state = {}
}

let saveTimer = null

function persist() {
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(`${planFile}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${planFile}.tmp`, planFile)
  } catch (error) {
    log.error('[规划] 落盘失败', { error: error?.message ?? String(error) })
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 300)
  saveTimer.unref?.()
}

export function isPlanning(key) {
  return Boolean(state[key])
}

export function getPlan(key) {
  return state[key] ?? null
}

/** 进入规划模式 */
export function enterPlan(key, task) {
  const plan = {
    task: String(task ?? '').trim().slice(0, 500),
    content: '',
    submittedAt: 0,
    createdAt: Date.now(),
  }
  state[key] = plan
  scheduleSave()
  return plan
}

/** 模型提交方案。submitted 之后就不再让它继续探索了 */
export function submitPlan(key, content) {
  const plan = state[key]
  if (!plan) return null

  plan.content = String(content ?? '').trim().slice(0, 8000)
  plan.submittedAt = Date.now()
  scheduleSave()
  return plan
}

/** 批准：退出规划，把方案交出去执行 */
export function exitPlan(key) {
  const plan = state[key]
  delete state[key]
  scheduleSave()
  return plan ?? null
}

/** 放弃：不执行，直接丢掉 */
export function cancelPlan(key) {
  const had = Boolean(state[key])
  delete state[key]
  scheduleSave()
  return had
}

/** 方案能不能执行（得先提交过） */
export function planReady(key) {
  const plan = state[key]
  return Boolean(plan && plan.submittedAt > 0 && plan.content)
}

export function flushPlans() {
  persist()
}

/** 规划模式的提示词：插在系统提示末尾 */
export function planModePrompt(plan) {
  return [
    '【当前处于规划模式】',
    `要做的事：${plan.task || '（未说明）'}`,
    '',
    '这个模式只能读，不能改：写文件、执行命令、发消息这些工具现在都不可用，别去调它们。',
    '',
    '按这个顺序做：',
    '1. 先弄清楚现状：需要看什么就读什么，别猜。代码、配置、目录结构都能读。',
    '2. 想清楚怎么做，权衡一下有没有更简单的路子。',
    '3. 复核关键文件，确认你的理解没错。',
    '4. 把方案写出来，调用 exit_plan_mode 提交。对方会看到方案，决定要不要执行。',
    '',
    '方案要写成对方能直接看懂的样子：打算做几步、每步做什么、会动到哪些文件、有什么风险。',
    '不要一次给三四个方案让他挑——挑一个你认为最好的，说明理由。真有必要才给备选。',
    '不要在正文里问「要不要执行」，提交方案本身就是询问。',
  ].join('\n')
}
