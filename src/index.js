import fs from 'node:fs'
import path from 'node:path'
import { env } from './config/env.js'
import { dataPath, ensureDirs, paths } from './config/paths.js'
import { describeAdminPolicy, describePolicy, isDangerousTool } from './config/policy.js'
import { chat } from './chat/chat.js'
import { clearAllMerged, mergeMessage } from './chat/merge.js'
import { personaName } from './chat/persona.js'
import { runTaskAgent } from './chat/agent.js'
import { cleanupIncoming, describeInbound } from './channel/incoming.js'
import { sendReply } from './channel/sender.js'
import { getTools, startMcp, stopMcp } from './mcp/client.js'
import { flush, migrateLegacySessions, reset, stats } from './memory/memory.js'
import { flushTodos } from './chat/todos.js'
import { cleanupSpill } from './chat/truncate.js'
import { startAutoSync } from './ops/git-sync.js'
import { llmLimiter } from './chat/llm.js'
import { toolLimiterStats } from './chat/tool-runner.js'
import { cancelPlan, enterPlan, exitPlan, flushPlans, getPlan, isPlanning, planReady } from './chat/plan.js'
import { canPushTo, flushActivity, idleMinutesOf, lastActiveAt, touchActivity } from './ops/activity.js'
import { acquireInstanceLock } from './ops/instance.js'
import { log } from './ops/logger.js'
import { describePlatform } from './ops/platform.js'
import { tightenPermissions } from './ops/permissions.js'
import {
  addSchedule,
  cronMatches,
  initScheduler,
  listSchedules,
  nextMatchOf,
  removeSchedule,
  schedulerStatus,
} from './tasks/scheduler.js'
import { busyTasks, killTask, startTask, submitInput, taskStatus } from './tasks/task-runner.js'
import { flushTickets, recoverTickets } from './tasks/ticket.js'
import { startWatchdog, stopWatchdog } from './tasks/watchdog.js'
import { getClient, startAll, stopAll, tenantsStatus } from './tenants/manager.js'
import { listTenants, migrateLegacyCredential } from './tenants/store.js'
import { userIdOf, userKey } from './tenants/keys.js'
import { startWebServer, stopWebServer } from './web/server.js'

// 让内置 MCP 子进程知道自己在 pm2 里、应用叫什么，restart_self 要用。
// 少了这两行，机器人在 pm2 下调 restart_self 会报「不是 pm2 托管」——
// pm2 会设 pm_id 和 name，其它启动方式没有。
process.env.PM2_MANAGED = process.env.pm_id !== undefined ? '1' : '0'
process.env.PM2_APP_NAME = process.env.name?.trim() || process.env.PM2_APP_NAME?.trim() || 'dafeiyu'

const dataDir = paths.data
ensureDirs()

const startedAt = Date.now()
let shuttingDown = false
let releaseLock = null

// 平台偶尔会重推同一条消息。带上租户前缀——虽然 message_id 本身全局唯一，
// 多账号同跑时不靠这个假设更稳。
const seen = new Set()
function firstTime(tenantId, messageId) {
  const id = `${tenantId}:${messageId ?? ''}`
  if (!id.endsWith(':')) {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) {
      for (const item of [...seen].slice(0, 1000)) seen.delete(item)
    }
  }
  return true
}

// 同一个会话的消息串行处理
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
  // 必须带账号前缀：同一个微信号可能先后扫两个 ClawBot 的码，
  // 只用 user:<id> 的话两个账号的对话会共用一份记忆
  return userKey(event.tenantId, event.user_id)
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
 * 定时任务的执行体：当成后台任务跑，不需要 event。
 * 返回的文本会被调度器推给对方；回空串或 SILENT 就不推。
 */
async function runScheduledTask(task) {
  const tenantId = task.target?.tenantId ?? ''
  const client = getClient(tenantId)
  if (!client) throw new Error(`账号 ${tenantId || '(未指定)'} 没在运行，没法推送`)

  const userId = task.target.id
  return runTaskAgent({
    taskPrompt: `${task.prompt}\n\n（这是定时任务，你现在没有对话上下文。你的最终输出会作为一条消息直接发给对方；如果确实没什么可说的，就只输出 SILENT）`,
    sessionKey: userKey(tenantId, userId),
    actor: task.createdBy || 'scheduler',
    send: (payload) => client.sendToUser(userId, payload),
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

const COMMANDS = {
  '/help': () => [
    '可用的命令：',
    '',
    '对话与记忆',
    '/reset 清空当前对话记忆',
    '/memory 看记忆用量',
    '/id 看你自己的 id（也用来配权限）',
    '/tools 看当前有哪些工具',
    '/config 看当前配置',
    '/diag 发送自检',
    '/tenants 看这个进程托管了哪些微信账号',
    '',
    '后台工单（长任务丢后台跑，中途汇报进度）',
    '/plan <要做的事> 先出方案，你确认后再执行（复杂任务推荐）',
    '/task <要做的事> 直接起一个工单',
    '/tasks 看正在跑的工单',
    '/kill <工单号> 中止',
    '',
    '定时任务',
    '/schedule <cron> <任务> 加一条，如 /schedule 0 9 * * * 每天说早安',
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
    const userId = String(event?.user_id ?? '')
    const tenantId = String(event?.tenantId ?? '')
    const client = getClient(tenantId)
    const lines = [
      `你的 id：${userId || '（这次拿不到）'}`,
      `当前账号：${tenantId || '未知'}${client?.selfId() ? `（机器人身份 ${client.selfId()}）` : ''}`,
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
      '要开放，把下面这行原样写进密钥文件（/etc/wechatbot/env 或 .env），然后重启我：',
      `ADMIN_USER_IDS=${userId || '<你的 id>'}`,
      '',
      '只开给指定 id 是最小权限的做法；单人自用也可以设 ALLOW_DANGEROUS=true，但不推荐。',
      '注意：即使开放了，读 .env、读 data/ 下的记忆和凭证这些操作仍然会被拦。',
    )
    return lines.join('\n')
  },

  '/tenants': () => {
    const list = tenantsStatus()
    if (list.length === 0) return '还没有任何账号。打开 Web 页面扫码接入。'
    return list
      .map((item) => {
        const state = !item.loggedIn ? '未登录' : item.running ? '运行中' : '已登录未启动'
        return `${item.name}（${item.id}）｜${state}${item.selfId ? `｜${item.selfId}` : ''}`
      })
      .join('\n')
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
    `账号 ${tenantsStatus().length} 个`,
    `权限：${describeAdminPolicy()}`,
    `日志级别 ${env.logLevel}${env.toolDebug ? '（工具调用详细日志已开）' : ''}`,
  ].join('\n'),

  '/diag': (key, rest, event) => {
    const tenantId = String(event?.tenantId ?? '')
    const client = getClient(tenantId)
    const s = stats(key)
    const tools = getTools()
    const idle = idleMinutesOf(key)
    const sched = schedulerStatus()
    const workers = taskStatus()
    const tenants = tenantsStatus()

    return [
      '自检：',
      `· 当前账号：${tenantId}${client?.selfId() ? `（${client.selfId()}）` : '（未运行）'}`,
      `· 账号总数：${tenants.length} 个，运行中 ${tenants.filter((t) => t.running).length} 个`,
      `· 运行：${formatDuration(Date.now() - startedAt)}`,
      `· 工具：${tools.length} 个 MCP 工具 + 15 个本地工具`,
      `· 记忆：短期 ${s.shortTerm} 轮、摘要 ${s.midTermChars} 字、长期 ${s.longTerm} 条`,
      `· 工单：在跑 ${workers.length} 个`,
      `· 定时：${sched.total} 条（启用 ${sched.enabled}），上次检查 ${sched.tickAgeSeconds ?? '?'} 秒前`,
      `· 你最后一次说话：${idle === Number.POSITIVE_INFINITY ? '无记录' : `${Math.round(idle)} 分钟前`}`,
      (() => {
        const llm = llmLimiter.stats()
        const tool = toolLimiterStats()
        return (
          `· 并发：模型 ${llm.active}/${llm.limit}（排队 ${llm.queued}，峰值 ${llm.peak}，平均等 ${llm.avgWaitMs}ms）｜` +
          `工具 ${tool.active}/${tool.limit}（排队 ${tool.queued}）`
        )
      })(),
      `· Node ${process.version}｜内存 ${Math.round(process.memoryUsage().rss / 1048576)}MB`,
    ].join('\n')
  },

  '/plan': (key, rest, event) => {
    const task = String(rest ?? '').trim()
    if (!task) return '用法：/plan 要做的事\n\n进入规划模式：我只看不改，先给方案，你说执行我再动手。'

    if (isPlanning(key)) return '已经在规划中了。方案给你之后回「执行」，或者直接说哪里要改。'

    enterPlan(key, task)
    // 立刻排一轮规划对话，不用你再说一遍
    enqueue(key, () => handleMessage(event, task))
    return '进入规划模式，先摸清楚情况再给方案，不动任何东西。'
  },

  '/task': (key, rest, event) => {
    const goal = String(rest ?? '').trim()
    if (!goal) return '用法：/task 要做的事'

    const { id } = startTask({
      sessionKey: key,
      tenantId: String(event?.tenantId ?? ''),
      actor: event.user_id ?? '',
      goal,
      notify: (text) => event.send([{ type: 'text', data: { text } }]),
      send: (payload) => event.send(payload),
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
      // 记住是哪个账号建的：到点推送要用这个账号发出去
      target: { type: 'user', id: event.user_id ?? '', tenantId: String(event?.tenantId ?? '') },
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
      await sendReply(event, command(key, rest, event))
    } catch (error) {
      await sendReply(event, `命令执行失败：${error?.message ?? error}`)
    }
    return
  }

  // 规划模式且方案已提交：这时候等的是「执行」或者修改意见
  if (isPlanning(key) && planReady(key)) {
    const trimmed = String(text ?? '').trim()
    const confirmed =
      trimmed.length <= 8 &&
      /^(执行|开始|可以|可行|行|好|没问题|就这样|跑吧|干吧|ok|okay|yes|go)/i.test(trimmed)

    if (confirmed) {
      const approved = exitPlan(key)
      const { id } = startTask({
        sessionKey: key,
        tenantId: String(event.tenantId ?? ''),
        actor: event.user_id ?? '',
        goal: `任务：${approved.task}

已批准的方案：
${approved.content}`.slice(0, 1800),
        notify: (body) => event.send([{ type: 'text', data: { text: body } }]),
        send: (payload) => event.send(payload),
      })
      await sendReply(event, `方案通过，工单 ${id} 开始执行，做完我汇报。`)
      return
    }

    if (/^(算了|取消|不用了|放弃|先不)/.test(trimmed)) {
      cancelPlan(key)
      await sendReply(event, '好，方案取消，什么都没动。')
      return
    }

    // 其他话当成对方案的反馈，往下走让它继续规划
  }

  // 工单跑着的时候，新消息直接投给那个工单，不另开一轮对话
  const running = submitInput(key, text)
  if (running) {
    await sendReply(event, `已经转给正在跑的工单 ${running}，它下一步就会看到。`)
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
      const client = getClient(event.tenantId)
      if (!client) throw new Error(`账号 ${event.tenantId} 没在运行`)
      const described = await describeInbound(client, inbound, key)
      input = `${input}\n\n（对方还发了 ${inbound.length} 个附件）\n${described.text}`.trim()
      images = described.images
    } catch (error) {
      log.warn('附件处理失败', { error: error?.message ?? String(error) })
      input = `${input}\n\n（对方发了 ${inbound.length} 个附件，但下载失败了：${error?.message ?? error}）`.trim()
    }
  }

  const client = getClient(event.tenantId)
  client?.sendTyping(event.user_id)

  try {
    const planBefore = getPlan(key)?.submittedAt ?? 0

    const answer = await chat(key, input || '（只发了附件，没有文字）', {
      images,
      name: '',
      actor: event.user_id ?? '',
      send: (payload) => event.send(payload),
    })

    // 这一轮刚提交了方案：把方案原文发出去，等他决定
    const planAfter = getPlan(key)
    if (planAfter && planAfter.submittedAt > planBefore) {
      await sendReply(event, `方案：

${planAfter.content}

要执行就回「执行」，哪里不合适直接说。`)
      return
    }

    await sendReply(event, answer)
  } catch (error) {
    log.error(`模型调用失败 ${key}`, { error: error?.message ?? String(error) })
    await sendReply(event, '抱歉，我这边暂时无法回答，请稍后再试。').catch(() => {})
  }
}

/** 统一消息入口：所有账号的消息都进这里 */
function handleEvent(event) {
  if (!firstTime(event.tenantId, event.message_id)) {
    log.warn(`这条消息重推了，跳过：${event.message_id}`)
    return
  }

  const key = sessionKeyOf(event)
  touchActivity(key)

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
      const last = events[events.length - 1]
      const merged = events
        .map((item) => String(item.content ?? '').trim())
        .filter(Boolean)
        .join('\n')

      if (events.length > 1) log.info(`连发 ${events.length} 条合成一次理解`)
      enqueue(key, () => handleMessage(last, merged))
    },
  )
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
    flushTodos()
    flushPlans()
  } catch (error) {
    log.error('落盘失败', { error: error?.message ?? String(error) })
  }

  stopWatchdog()
  stopWebServer()
  stopAll()
  await Promise.race([
    stopMcp(),
    new Promise((resolve) => setTimeout(resolve, 5000).unref()),
  ]).catch(() => {})

  releaseLock?.()
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
  // 单实例锁：同一个凭证目录只能一个进程轮询。
  // 多账号都在本进程内，所以一个进程级锁就够了。
  releaseLock = acquireInstanceLock(dataPath.instanceLock)

  const tightened = tightenPermissions()
  if (tightened.length > 0) log.info(`已收紧文件权限：${tightened.join('，')}`)

  log.info(`平台：${describePlatform()}`)

  // 老版本的单账号凭证搬到租户目录，不用重新扫码
  migrateLegacyCredential()

  // 旧会话键 user:<id> 要补上账号前缀，否则升级后记忆全找不到了。
  // 只在账号唯一时迁移——多个账号时没法判断旧数据到底属于谁。
  const tenantsNow = listTenants()
  if (tenantsNow.length === 1) {
    const moved = migrateLegacySessions(tenantsNow[0].id)
    if (moved > 0) log.info(`[记忆] ${moved} 个旧会话已挂到账号「${tenantsNow[0].name}」名下`)
  } else if (tenantsNow.length > 1) {
    log.warn('[记忆] 有多个账号，旧会话无法判断归属，未自动迁移')
  }

  try {
    const tools = await startMcp({ apiKey: env.apiKey, baseURL: env.baseURL })
    log.info(`工具已就绪：${describePolicy(tools.map((tool) => tool.name))}`)
    log.info(`权限：${describeAdminPolicy()}`)
    const blocked = tools.filter((tool) => isDangerousTool(tool.name)).map((tool) => tool.name)
    if (blocked.length > 0 && env.adminUserIds.length === 0 && !env.allowDangerous) {
      log.warn(`高危工具已禁用：${blocked.join(' ')}`)
      log.warn('要开放：在密钥文件里配 ADMIN_USER_IDS=<你的 id>，或设 ALLOW_DANGEROUS=true')
    }
  } catch (error) {
    log.error('工具服务启动失败，降级为纯聊天', { error: error?.message ?? String(error) })
  }

  // 启动所有已登录的账号
  const info = await startAll(handleEvent)
  log.info(`[租户] 共 ${info.total} 个账号，已启动 ${info.started} 个，待登录 ${info.pending} 个`)

  if (info.total === 0) {
    log.warn('[租户] 还没有任何账号。启动 Web 页面（见 WEB_PORT）扫码接入。')
  }

  initScheduler({
    sendMessage: async (target, text) => {
      const client = getClient(target?.tenantId ?? '')
      if (!client) throw new Error(`账号 ${target?.tenantId || '(未指定)'} 没在运行，没法推送`)

      const key = userKey(target?.tenantId ?? '', target.id)
      if (!canPushTo(key)) {
        throw new Error(`已经 ${Math.round(idleMinutesOf(key))} 分钟没说话了，主动推送大概率发不出去`)
      }
      await client.sendToUser(target.id, text)
      return []
    },
    runTask: runScheduledTask,
  })

  startWatchdog({
    send: async (target, text) => {
      const client = getClient(target?.tenantId ?? '')
      if (!client) return
      if (!canPushTo(userKey(target?.tenantId ?? '', target.id))) return
      await client.sendToUser(target.id, text).catch(() => {})
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
    const client = getClient(ticket.tenantId ?? '')
    const userId = userIdOf(ticket.sessionKey)
    if (!client || !userId) continue
    await client
      .sendToUser(userId, `上次有个工单没跑完（${ticket.id}）：\n${String(ticket.goal ?? '').slice(0, 100)}\n\n要重跑就发 /task 重新发起。`)
      .catch(() => {})
  }
  if (interrupted.length > 0) log.warn(`发现 ${interrupted.length} 个被中断的工单，已通知`)

  // 多账号管理页面。默认只听 127.0.0.1，扫码接入新账号用
  startWebServer()

  log.info(`人格 ${personaName}，模型 ${env.model}`)
  console.log('[启动] 就绪。私聊直接发消息，发 /help 看命令。')

  // 代码同步：定时把改动推上去，再把远端拉下来合并
  startAutoSync(env.autoSyncMinutes)

  // 入站附件每小时清一次
  const cleaner = setInterval(() => {
    if (shuttingDown) return
    try {
      const removed = cleanupIncoming(env.mediaTtlHours)
      if (removed > 0) log.info(`回收附件 ${removed} 个`)

      // 工具输出落盘的文件也别一直堆着
      const spill = cleanupSpill(24)
      if (spill > 0) log.info(`回收工具输出 ${spill} 个`)
    } catch (error) {
      log.warn('清理失败', { error: error?.message ?? String(error) })
    }
  }, 60 * 60 * 1000)
  cleaner.unref?.()

  // 各账号的 start() 都不 await（它们会一直跑到 stop），
  // 这里挂一个永不 resolve 的 promise 让进程保持活着，靠信号退出
  await new Promise(() => {})
}

main().catch((error) => {
  console.error('[启动] 失败：', error?.message ?? error)
  releaseLock?.()
  process.exit(1)
})
