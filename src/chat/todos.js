import fs from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// 任务清单。
//
// 搬自 Kimi Code 的 TodoList（packages/agent-core-v2/src/features/todo），
// 只取数据和提示语义，它那套 xstate + DI 不搬——我们这边一个 Map 加一个文件就够。
//
// 为什么要有：多步任务最容易出的问题是「做着做着忘了要干什么」。
// 前半段查资料，后半段忘了用户还要求"整理成表格"，最后交一半。
// 清单挂在提示词里，模型每轮都看得到自己在第几步。

const dataDir = path.join(env.projectRoot, 'data')
const todoFile = path.join(dataDir, 'todos.json')

export const TODO_STATUS = ['pending', 'in_progress', 'done']

/**
 * 清单按会话分开存：<sessionKey> -> [{ title, status }]
 * sessionKey 已经带账号前缀（tenants/keys.js），多账号天然隔离。
 */
let state = {}

try {
  const raw = JSON.parse(fs.readFileSync(todoFile, 'utf8'))
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
    fs.writeFileSync(`${todoFile}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${todoFile}.tmp`, todoFile)
  } catch (error) {
    console.error('[清单] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 300)
  saveTimer.unref?.()
}

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = String(raw.title ?? '').trim().slice(0, 120)
  if (!title) return null
  const status = TODO_STATUS.includes(raw.status) ? raw.status : 'pending'
  return { title, status }
}

/** 全量替换。传空数组等于清空 */
export function setTodos(key, todos) {
  const list = Array.isArray(todos) ? todos.map(cleanItem).filter(Boolean).slice(0, 30) : []

  // 只允许一个 in_progress：模型偶尔会顺手把两项都标成进行中，
  // 那样「当前在做哪件事」就说不清了，后面的提醒也没法定位
  let seenActive = false
  for (const item of list) {
    if (item.status !== 'in_progress') continue
    if (seenActive) item.status = 'pending'
    seenActive = true
  }

  if (list.length === 0) delete state[key]
  else state[key] = list

  scheduleSave()
  return list
}

export function getTodos(key) {
  const list = state[key]
  return Array.isArray(list) ? list : []
}

export function clearTodos(key) {
  delete state[key]
  scheduleSave()
}

export function todoProgress(todos) {
  const done = todos.filter((item) => item.status === 'done').length
  const inProgress = todos.filter((item) => item.status === 'in_progress')
  return {
    total: todos.length,
    done,
    open: todos.length - done,
    inProgress,
  }
}

/** 渲染成给模型/日志看的文本 */
export function renderTodos(todos, title = '当前任务清单：') {
  if (!todos || todos.length === 0) return ''
  const lines = [title]
  for (const [index, item] of todos.entries()) {
    const marker =
      item.status === 'done' ? '[已完成]' : item.status === 'in_progress' ? '[进行中]' : '[待办]'
    lines.push(`  ${index + 1}. ${marker} ${item.title}`)
  }
  return lines.join('\n')
}

/**
 * 清单该不该催一句。
 *
 * 模型建完清单经常就不管了——该标 done 的不标，最后交付时清单还停在第一步。
 * Kimi Code 的做法是：连着 N 步没更新、且还有没做完的项，就往上下文塞一条提醒。
 * 这里按「工具轮数」算步数，够用且不用改上下文结构。
 *
 * @param {object[]} todos
 * @param {number} stepsSinceWrite 距上次写清单过了几轮
 * @param {number} threshold
 */
export function staleReminder(todos, stepsSinceWrite, threshold = 5) {
  if (!Array.isArray(todos) || todos.length === 0) return ''
  const { open, done, inProgress } = todoProgress(todos)
  if (open === 0) return ''
  if (stepsSinceWrite < threshold) return ''

  const current = inProgress[0]
  const status =
    current === undefined
      ? `${done}/${todos.length} 已完成，没有进行中的项`
      : `${done}/${todos.length} 已完成，「${current.title}」还标着进行中`

  return [
    `（提醒：任务清单已经 ${stepsSinceWrite} 轮没更新了，${status}。`,
    '如果有做完了的就标 done；清单和实际做的对不上了就重写或清空；还对得上就不用动。',
    '这条提醒不用回给用户，也不用向用户解释。）',
    '',
    renderTodos(todos),
  ].join('\n')
}

export function flushTodos() {
  persist()
}
