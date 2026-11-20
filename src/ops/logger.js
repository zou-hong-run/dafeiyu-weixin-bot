import fs from 'node:fs'
import { paths } from '../config/paths.js'
import path from 'node:path'
import { env } from '../config/env.js'

// 日志：控制台 + 按天落盘。
//
// 前台跑的时候看控制台，pm2 / 后台跑的时候翻 logs/ 下的文件。
// 不拦截 console——SDK 内部有它自己的 logger，我们通过 bot 的 logger 选项
// 把它接进来（见 sdkLogger），比事后劫持全局 console 干净。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const logDir = paths.logs
const KEEP_DAYS = 7

let currentDay = ''
let currentFile = ''

function levelOf() {
  return LEVELS[String(env.logLevel ?? 'info').toLowerCase()] ?? LEVELS.info
}

/** 保留最近 N 天的日志，超出的删掉 */
function pruneOld() {
  try {
    const files = fs.readdirSync(logDir).filter((name) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    if (files.length <= KEEP_DAYS) return
    files.sort()
    for (const name of files.slice(0, files.length - KEEP_DAYS)) {
      fs.rmSync(path.join(logDir, name), { force: true })
    }
  } catch {
    // 清理失败不影响写日志
  }
}

function fileForToday() {
  const day = new Date().toISOString().slice(0, 10)
  if (day !== currentDay) {
    currentDay = day
    currentFile = path.join(logDir, `bot-${day}.log`)
    fs.mkdirSync(logDir, { recursive: true })
    pruneOld()
  }
  return currentFile
}

function formatData(data) {
  if (data == null) return ''
  if (typeof data === 'string') return data ? ` ${data}` : ''
  try {
    const text = JSON.stringify(data)
    return text === '{}' ? '' : ` ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`
  } catch {
    return ''
  }
}

function emit(level, context, message, data) {
  if (LEVELS[level] < levelOf()) return

  const prefix = context ? `[${context}] ` : ''
  const line =
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${message}` +
    formatData(data)

  const toConsole = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  toConsole(line)

  // 落盘失败不能反过来影响业务
  try {
    fs.appendFileSync(fileForToday(), `${line}\n`)
  } catch {
    // 写不进去就算了，控制台已经有
  }
}

function makeLogger(context = '') {
  return {
    debug: (message, data) => emit('debug', context, message, data),
    info: (message, data) => emit('info', context, message, data),
    warn: (message, data) => emit('warn', context, message, data),
    error: (message, data) => emit('error', context, message, data),
    child: (name) => makeLogger(context ? `${context}:${name}` : name),
  }
}

/** 业务代码用这个 */
export const log = makeLogger()

/** 传给 WeChatBot 的 logger，让 SDK 的日志也进同一个文件 */
export const sdkLogger = makeLogger('sdk')
