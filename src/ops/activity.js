import fs from 'node:fs'
import { dataPath } from '../config/paths.js'
import path from 'node:path'
import { env } from '../config/env.js'

// 活跃度台账。
//
// 为什么需要它：微信的 context_token 会随会话放旧，主动发送（不是回复）
// 用的是缓存里那份 token，放久了服务端就回 prepare failed。
// 所以「他多久没说话了」是能不能主动推的唯一判断依据。
//
// 现在只记录和提供判断接口；等接定时任务时直接用 canPushTo()。

const file = dataPath.activity

let state = {}
try {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw && typeof raw === 'object') state = raw
} catch {
  state = {}
}

let saveTimer = null

function flush() {
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  } catch (error) {
    console.error('[活跃度] 落盘失败：', error?.message ?? error)
  }
}

function schedule() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 1000)
  saveTimer.unref?.()
}

/** 记一笔活跃：收到消息就调，不用等模型回完 */
export function touchActivity(key, at = Date.now()) {
  const id = String(key ?? '').trim()
  if (!id) return
  state[id] = at
  schedule()
}

export function lastActiveAt(key) {
  return Number(state[key]) || 0
}

/** 距今闲置多少分钟。从没活跃过返回 Infinity */
export function idleMinutesOf(key) {
  const at = lastActiveAt(key)
  if (!at) return Number.POSITIVE_INFINITY
  return (Date.now() - at) / 60_000
}

/**
 * 能不能给他主动推一条。
 * token 放太久就大概率发不出去，宁可不推，也别在日志里留一堆无声失败。
 */
export function canPushTo(key, maxIdleMinutes = env.pushMaxIdleMinutes) {
  return idleMinutesOf(key) <= maxIdleMinutes
}

/** 最近活跃过的会话，按时间倒序 */
export function recentActiveSessions(withinMs = 30 * 60_000) {
  const now = Date.now()
  return Object.entries(state)
    .filter(([, at]) => now - Number(at) <= withinMs)
    .map(([key, at]) => ({ key, at: Number(at) }))
    .sort((a, b) => b.at - a.at)
}

export function flushActivity() {
  flush()
}
