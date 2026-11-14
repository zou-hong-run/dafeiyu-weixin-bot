import fs from 'node:fs'
import path from 'node:path'
import qrcode from 'qrcode-terminal'
import { env } from './config/env.js'
import { describeAdminPolicy, describePolicy, isDangerousTool } from './config/policy.js'
import { chat } from './chat/chat.js'
import { clearAllMerged, mergeMessage } from './chat/merge.js'
import { personaName } from './chat/persona.js'
import { cleanupIncoming, describeInbound } from './channel/incoming.js'
import { sendReply } from './channel/sender.js'
import { sendTo, sendToUser, sendTyping, login, onLifecycle, onMessage, selfId, start, stop, tokenStatus } from './channel/wechat.js'
import { getTools, startMcp, stopMcp } from './mcp/client.js'
import { flush, reset, stats } from './memory/memory.js'
import { canPushTo, flushActivity, idleMinutesOf, lastActiveAt, touchActivity } from './ops/activity.js'
import { log } from './ops/logger.js'
import { runTaskAgent } from './chat/agent.js'
import {
  cronMatches,
  addSchedule,
  initScheduler,
  listSchedules,
  nextMatchOf,
  removeSchedule,
  schedulerStatus,
} from './tasks/scheduler.js'
import { busyTasks, killTask, startTask, submitInput, taskStatus } from './tasks/task-runner.js'
import { flushTickets, recoverTickets } from './tasks/ticket.js'
import { startWatchdog, stopWatchdog } from './tasks/watchdog.js'

const dataDir = path.join(env.projectRoot, 'data')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(env.projectRoot, 'downloads'), { recursive: true })

const startedAt = Date.now()
let shuttingDown = false

// 平台偶尔会重推同一条消息，没有这道去重会回两遍
const seen = new Set()
function firstTime(messageId) {
  const id = String(messageId ?? '')
  if (!id) return true
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > 1000) {
    // Set 保留插入顺序，前半段是最老的
    const drop = [...seen].slice(0, 500)
    for (const item of drop) seen.delete(item)
  }
  return true
}

// 同一个会话的消息串行处理：别让多轮对话同时进模型互相抢历史
const chains = new Map()
function enqueue(key, task) {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev
    .then(task)
    .catch((error) => log.error(`处理失败 ${key}`, { error: error?.message ?? String(error) }))
  chains.set(key, next)
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key)
  })
  return next
}

function sessionKeyOf(event) {
  return `user:${event.user_id}`
}

/**
 * 跟对方说话。
 * 优先用这条入站消息的 context_token（最新的那份）；
 * 万一已经过期（工单跑了很久），退回主动发送，别让汇报无声丢掉。
 */
async function speak(event, text) {
  try {
    await sendReply(event, text)
  } catch (error) {
    log.warn('回复失败，改走主动发送', { error: error?.message ?? String(error) })
    await sendToUser(event.user_id, text).catch((err) => {
      log.error('主动发送也失败了', { error: err?.message ?? String(err) })
    })
  }
}

/** 扫码登录。凭证在 data/ilink/ 里，登录过一次后不会每次都扫 */
async function ensureLogin() {
  const callbacks = {
    onQrUrl: (content) => presentQr(content),
    onScanned: () => log.info('已扫码，请在手机上确认'),
    onExpired: () => log.warn('二维码过期了，正在换一张'),
    onVerifyCode: (isRetry) =>
      new Promise((resolve) => {
        process.stdout.write(isRetry ? '[登录] 配对码不对，请重新输入：' : '[登录] 请输入手机上显示的配对码：')
        process.stdin.resume()
        process.stdin.once('data', (chunk) => {
          process.stdin.pause()
          resolve(String(chunk).trim())
        })
      }),
  }

  const creds = await login(callbacks)
  log.info(`登录成功，机器人身份 ${creds.userId}`)
  return creds
}

/**
 * 二维码可能是一段跳转地址，也可能是图片内容。
 * 地址就用 qrcode-terminal 直接画在终端里——用微信扫屏幕最省事；
 * 图片就落一份到磁盘，让人打开看。
 */
function presentQr(content) {
  const value = String(content ?? '')
  if (/^https?:\/\//i.test(value)) {
    console.log('\n[登录] 用微信扫下面的二维码（链接失效时也可以直接打开）：')
    qrcode.generate(value, { small: true })
    console.log(value)
    console.log('')
    return
  }

  const base64 = value.replace(/^data:image\/[a-z]+;base64,/i, '')
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(base64)) {
    const file = path.join(dataDir, 'qrcode.png')
    try {
      fs.writeFileSync(file, Buffer.from(base64, 'base64'))
      console.log(`\n[登录] 二维码已存到 ${file}，打开扫一下\n`)
      return
    } catch (error) {
      log.warn('二维码存盘失败', { error: error?.message ?? String(error) })
    }
  }

  console.log(`\n[登录] 二维码内容：\n${value}\n`)
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

// ---------- 定时任务 ----------

/**
 * 定时任务的执行体：当成一个后台任务跑，不需要 event。
 * 返回的文本会被调度器推给对方；回空串或 SILENT 就不推。
 */
async function runScheduledTask(task) {
  const userId = task.target.id
  return runTaskAgent({
    taskPrompt: `${task.prompt}\n\n（这是定时任务，你现在没有对话上下文。你的最终输出会作为一条消息直接发给对方；如果确实没什么可说的，就只输出 SILENT）`,
    sessionKey: `user:${userId}`,
    // 权限跟着「谁建的这条定时任务」走，不凭空给一个 scheduler 身份。
    // 老任务没有 createdBy 时退回 scheduler——它不在白名单里，等于默认拒绝。
    actor: task.createdBy || 'scheduler',
    send: (payload) => sendToUser(userId, payload),
  })
}

// ---------- 命令 ----------

function taskListText(key) {
  const active = busyTasks(key)
  if (active.length === 0) return '当前没有在跑的工单。'
  return active
    .map((ticket) => `${ticket.id}｜第 ${ticket.step ?? 0} 步｜已跑 ${Math.round((Date.now() - ticket.createdAt) / 1000)} 秒`)
    .join('\n')
}

function scheduleListText(key) {
  const list = listSchedules(key)
  if (list.length === 0) return '还没有定时任务。用法：/schedule 0 9 * * * 每天早上给我一份科技新闻'
  return list
    .map((item) => `${item.id}｜${item.cron}｜${item.enabled ? '启用' : '停用'}｜下次 ${nextMatchOf(item.cron) ?? '解析失败'}\n   ${item.prompt}`)
    .join('\n')
}

/** 硬编码命令。看到就直接执行，不进模型 */
const COMMANDS = {
  '/help': () => [
    '可用的命令：',
    '',
    '对话与记忆',
    '/reset 清空当前对话记忆',
    '/memory 看记忆用量',
    '/id 看机器人自己的 userId',
    '/tools 看当前有哪些工具',
    '/config 看当前配置',
    '/diag 发送自检',
    '',
    '后台工单（长任务丢后台跑，中途汇报进度）',
    '/task <要做的事> 起一个工单',
    '/tasks 看正在跑的工单',
    '/kill <工单号> 中止',
    '',
    '定时任务',
    '/schedule <cron> <任务> 加一条，如 /schedule 0 9 * * * 每天早上说句早安',
    '/schedules 看所有定时任务',
    '/unschedule <编号> 删掉一条',
  ].join('\n'),

  '/reset': (key) => {
    reset(key)
    return '清空了，重新开始。'
  },

  '/memory': (key) => {
    const s = stats(key)
    return `短期 ${s.shortTerm} 轮、摘要 ${s.midTermChars} 字、长期 ${s.longTerm} 条、约 ${s.historyTokens} tokens`
  },

  '/id': (key, rest, event) => {
    // 微信 ClawBot 里「机器人的 userId」和「你的 userId」是同一个值，
    // 所以这里两个都列出来，免得你对着两串一样的字符串犯迷糊
    const userId = String(event?.user_id ?? '')
    const botId = selfId()
    const lines = [
      `你的 id：${userId || '（这次拿不到）'}`,
      `我的身份：${botId || '（还没登录）'}`,
    ]

    if (env.adminUserIds.length > 0) {
      lines.push('', `当前权限：${describeAdminPolicy()}`)
      lines.push(
        env.adminUserIds.includes(userId)
          ? '你在这个名单里，高危工具（shell / 写文件）可以用。'
          : '你不在这个名单里，高危工具用不了。',
      )
      return lines.join('\n')
    }

    if (env.allowDangerous) {
      lines.push('', `当前权限：${describeAdminPolicy()}`)
      lines.push('高危工具对所有人开放，仅适合单人自用。')
      return lines.join('\n')
    }

    lines.push(
      '',
      '当前权限：高危工具（shell / 写文件 / 清记忆）都关着',
      '',
      '要开放，把下面这行原样写进 .env，然后重启我：',
      `ADMIN_USER_IDS=${userId || '<你的 id>'}`,
      '',
      '只开给指定 id 是最小权限的做法；单人自用也可以设 ALLOW_DANGEROUS=true，但不推荐。',
      '注意：即使开放了，读 .env、读 data/ 下的记忆和凭证这些操作仍然会被拦。',
    )
    return lines.join('\n')
  },

  '/tools': () => {
    const tools = getTools()
    if (tools.length === 0) return '工具服务没起来，现在只有记忆类工具可用。'
    return `共 ${tools.length} 个工具：\n${describePolicy(tools.map((tool) => tool.name))}\n\n另有记忆工具 5 个、媒体发送工具 4 个。`
  },

  '/config': () => [
    `模型 ${env.model}（${env.baseURL}）`,
    `记忆 ${env.historyTurns} 轮 / 输入上限 ${env.maxInputChars} 字 / 回复上限 ${env.replyMaxChars} 字`,
    `工具 ${env.maxToolRounds} 轮上限，单次超时 ${env.toolTimeoutMs / 1000}s`,
    `工单 ${env.taskMaxRounds} 轮 / 验收续跑 ${env.taskMaxContinuations} 次 / 同时 ${env.taskConcurrency} 个`,
    `连发合并 ${env.mergeWindowMs > 0 ? `${env.mergeWindowMs}ms` : '关闭'}`,
    `主动推送门控 ${env.pushMaxIdleMinutes} 分钟`,
    `权限：${describeAdminPolicy()}`,
    `日志级别 ${env.logLevel}${env.toolDebug ? '（工具调用详细日志已开）' : ''}`,
  ].join('\n'),

  '/diag': (key) => {
    const creds = tokenStatus()
    const s = stats(key)
    const tools = getTools()
    const idle = idleMinutesOf(key)
    const sched = schedulerStatus()
    const workers = taskStatus()

    return [
      '自检：',
      `· 登录：${creds ? `已登录（${creds.userId}）` : '未登录'}`,
      `· 运行：${formatDuration(Date.now() - startedAt)}`,
      `· 工具：${tools.length} 个 MCP 工具 + 9 个本地工具`,
      `· 记忆：短期 ${s.shortTerm} 轮、摘要 ${s.midTermChars} 字、长期 ${s.longTerm} 条`,
      `· 工单：在跑 ${workers.length} 个`,
      `· 定时：${sched.total} 条（启用 ${sched.enabled}），上次检查 ${sched.tickAgeSeconds ?? '?'} 秒前`,
      `· 你最后一次说话：${idle === Number.POSITIVE_INFINITY ? '无记录' : `${Math.round(idle)} 分钟前`}`,
      `· Node ${process.version}｜内存 ${Math.round(process.memoryUsage().rss / 1048576)}MB`,
    ].join('\n')
  },

  '/task': (key, rest, event) => {
    const goal = String(rest ?? '').trim()
    if (!goal) return '用法：/task 要做的事'

    const { id } = startTask({
      sessionKey: key,
      actor: event.user_id ?? '',
      goal,
      notify: (text) => speak(event, text),
      send: (payload) => sendTo(event, payload),
    })
    return `工单 ${id} 开始跑了，做完我告诉你。跑着的时候你可以直接说话，我会转给它。`
  },

  '/tasks': (key) => taskListText(key),

  '/kill': (key, rest) => {
    const id = String(rest ?? '').trim()
    if (!id) return `用法：/kill <工单号>\n${taskListText(key)}`
    return `已中止 ${killTask(id)}。`
  },

  '/schedule': (key, rest, event) => {
    const parts = String(rest ?? '').trim().split(/\s+/)
    if (parts.length < 6) {
      return '用法：/schedule <cron> <任务>\ncron 是五段：分 时 日 月 周。\n例：/schedule 0 9 * * * 每天早上跟我说一句早安'
    }

    const cron = parts.slice(0, 5).join(' ')
    const prompt = String(rest).trim().split(/\s+/).slice(5).join(' ')
    if (!nextMatchOf(cron)) return `这个 cron 解析不了：${cron}\n五段格式，如 0 9 * * *`

    const task = addSchedule({
      sessionKey: key,
      target: { type: 'user', id: event.user_id ?? '' },
      cron,
      prompt,
      createdBy: event.user_id ?? '',
    })
    return `定时任务 ${task.id} 已加：${cron}，下次 ${nextMatchOf(cron)}`
  },

  '/schedules': (key) => scheduleListText(key),

  '/unschedule': (key, rest) => {
    const id = String(rest ?? '').trim()
    if (!id) return `用法：/unschedule <编号>\n${scheduleListText(key)}`
    removeSchedule(id, key, { actor: '', isAdmin: true })
    return `已删掉 ${id}。`
  },
}

async function handleMessage(event, overrideText = '') {
  const key = sessionKeyOf(event)
  let text = String(overrideText || event.content || '').trim()
  const inbound = Array.isArray(event.message) ? event.message : []

  if (!text && inbound.length === 0) return

  const [head] = text.split(/\s+/)
  const command = COMMANDS[head]
  if (command) {
    const rest = text.slice(head.length).trim()
    try {
      await speak(event, command(key, rest, event))
    } catch (error) {
      await speak(event, `命令执行失败：${error?.message ?? error}`)
    }
    return
  }

  // 工单跑着的时候，新消息直接投给那个工单，不另开一轮对话
  const running = submitInput(key, text)
  if (running) {
    await speak(event, `已经转给正在跑的工单 ${running}，它下一步就会看到。`)
    return
  }

  if (text.length > env.maxInputChars) {
    text = text.slice(0, env.maxInputChars)
  }

  // 附件：下载落盘，图片直接进视觉通道
  let input = text
  let images = []

  if (inbound.length > 0) {
    try {
      const described = await describeInbound(inbound, key)
      input = `${input}\n\n（对方还发了 ${inbound.length} 个附件）\n${described.text}`.trim()
      images = described.images
    } catch (error) {
      log.warn('附件处理失败', { error: error?.message ?? String(error) })
      input = `${input}\n\n（对方发了 ${inbound.length} 个附件，但下载失败了：${error?.message ?? error}）`.trim()
    }
  }

  sendTyping(event.user_id)

  try {
    const answer = await chat(key, input || '（只发了附件，没有文字）', {
      images,
      name: '',
      actor: event.user_id ?? '',
      send: (payload) => sendTo(event, payload),
    })
    await speak(event, answer)
  } catch (error) {
    log.error(`模型调用失败 ${key}`, { error: error?.message ?? String(error) })
    await speak(event, '抱歉，我这边暂时无法回答，请稍后再试。').catch(() => {})
  }
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  log.info(`收到 ${signal}，正在收尾`)

  const pending = clearAllMerged()
  if (pending > 0) log.warn(`有 ${pending} 批连发消息还没合并完，退出后不会再回`)

  try {
    flush()
    flushActivity()
    flushTickets()
  } catch (error) {
    log.error('落盘失败', { error: error?.message ?? String(error) })
  }

  stopWatchdog()
  stop()
  await Promise.race([
    stopMcp(),
    new Promise((resolve) => setTimeout(resolve, 5000).unref()),
  ]).catch(() => {})

  log.info('已清理完毕')
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝', { reason: String(reason).slice(0, 500) })
})

process.on('uncaughtException', (error) => {
  log.error('未捕获异常', { error: error?.message ?? String(error), stack: String(error?.stack).slice(0, 800) })
  shutdown('uncaughtException')
})

async function main() {
  onLifecycle({
    expired: () => log.warn('会话过期了，正在重新扫码'),
    restored: () => log.info('会话已恢复'),
    error: (error) => log.warn('网关可恢复错误', { error: String(error?.message ?? error).slice(0, 120) }),
    close: () => log.warn('长轮询已停止'),
  })

  // 工具服务先起来：它失败不影响聊天，只是能干的事少了
  try {
    const tools = await startMcp({ apiKey: env.apiKey, baseURL: env.baseURL })
    log.info(`工具已就绪：${describePolicy(tools.map((tool) => tool.name))}`)
    log.info(`权限：${describeAdminPolicy()}`)
    const blocked = tools.filter((tool) => isDangerousTool(tool.name)).map((tool) => tool.name)
    if (blocked.length > 0 && env.adminUserIds.length === 0 && !env.allowDangerous) {
      log.warn(`高危工具已禁用：${blocked.join(' ')}`)
      log.warn('要开放其中任何一个：在 .env 配 ADMIN_USER_IDS=<你的 id>，或设 ALLOW_DANGEROUS=true（仅建议单人自用）')
    }
  } catch (error) {
    log.error('工具服务启动失败，降级为纯聊天', { error: error?.message ?? String(error) })
  }

  await ensureLogin()

  onMessage((event) => {
    if (!firstTime(event.message_id)) {
      log.warn(`这条消息重推了，跳过：${event.message_id}`)
      return
    }

    const key = sessionKeyOf(event)
    // 一收到就记活跃：主动推送能不能发，靠的就是这个时间
    touchActivity(key)

    // 命令和工单订阅要立刻处理，不能等合并窗口
    const head = String(event.content ?? '').trim().split(/\s+/)[0]
    if (COMMANDS[head] || (event.message?.length ?? 0) > 0) {
      enqueue(key, () => handleMessage(event))
      return
    }

    if (env.mergeWindowMs <= 0) {
      enqueue(key, () => handleMessage(event))
      return
    }

    mergeMessage(
      {
        sessionKey: key,
        userId: event.user_id,
        text: event.content,
        event,
        windowMs: env.mergeWindowMs,
        immediate: false,
      },
      ({ events }) => {
        // 用最后一条的 event 发回复：context_token 最新的就在它身上
        const last = events[events.length - 1]
        const merged = events
          .map((item) => String(item.content ?? '').trim())
          .filter(Boolean)
          .join('\n')

        if (events.length > 1) log.info(`连发 ${events.length} 条合成一次理解`)
        enqueue(key, () => handleMessage(last, merged))
      },
    )
  })

  // 调度器：定时任务靠它触发。推送前用活跃度门控——token 放太久发了也白发
  initScheduler({
    sendMessage: async (target, text) => {
      const key = `user:${target.id}`
      if (!canPushTo(key)) {
        throw new Error(`已经 ${Math.round(idleMinutesOf(key))} 分钟没说话了，主动推送大概率发不出去`)
      }
      await sendToUser(target.id, text)
      return []
    },
    runTask: runScheduledTask,
  })

  // 巡检：不参与执行，只站在外面看工单有没有卡住或陷入无效循环
  startWatchdog({
    send: async (target, text) => {
      if (!canPushTo(`user:${target.id}`)) return
      await sendToUser(target.id, text).catch(() => {})
    },
    abort: (ticketId) => {
      try {
        killTask(ticketId)
        return true
      } catch {
        return false
      }
    },
  })

  // 上次没跑完的工单：告诉对方，别让它以为还在跑
  const interrupted = recoverTickets()
  for (const ticket of interrupted) {
    const userId = String(ticket.sessionKey ?? '').replace(/^user:/, '')
    if (!userId) continue
    await sendToUser(
      userId,
      `上次有个工单没跑完（${ticket.id}）：\n${String(ticket.goal ?? '').slice(0, 100)}\n\n要重跑就发 /task 重新发起。`,
    ).catch(() => {})
  }
  if (interrupted.length > 0) log.warn(`发现 ${interrupted.length} 个被中断的工单，已通知`)

  log.info(`人格 ${personaName}，模型 ${env.model}`)
  console.log('[启动] 长轮询中。私聊直接发消息即可，发 /help 看命令。')

  // 入站附件每小时清一次，留着会一直涨
  const cleaner = setInterval(() => {
    if (shuttingDown) return
    try {
      const removed = cleanupIncoming(env.mediaTtlHours)
      if (removed > 0) log.info(`回收附件 ${removed} 个`)
    } catch (error) {
      log.warn('清理失败', { error: error?.message ?? String(error) })
    }
  }, 60 * 60 * 1000)
  cleaner.unref?.()

  // start() 会一直跑到 stop()，长轮询本身不抛错就代表还在工作
  await start()
  flush()
  flushActivity()
  flushTickets()
}

main().catch((error) => {
  console.error('[启动] 失败：', error?.message ?? error)
  process.exit(1)
})
