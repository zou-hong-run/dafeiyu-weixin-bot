import { env } from '../config/env.js'
import { denyReason, isToolAllowed } from '../config/policy.js'
import { callTool } from '../mcp/client.js'
import { auditSend, auditTool } from '../ops/audit.js'
import { LOCAL_TOOL_NAMES, makeLocalHandlers } from './local-tools.js'
import { MEDIA_TOOL_NAMES, makeMediaHandlers } from './media-tools.js'
import { TODO_TOOL_NAMES, makeTodoHandlers } from './todo-tools.js'
import { PLAN_TOOL_NAMES, makePlanHandlers } from './plan-tools.js'
import { createLimiter } from './limiter.js'
import { SKILL_TOOL_NAMES, makeSkillHandlers } from './skill-tools.js'
import { GIT_TOOL_NAMES, makeGitHandlers } from './git-tools.js'

// 工具执行层：对话和后台工单共用同一套权限判断和分流逻辑。
//
// 放在这里而不是 chat.js 里，是因为 worker 也要调工具——
// 两处各写一遍的话，权限判断迟早会漂移（一处补了、另一处漏了）。
//
// 审计也在这里做：所有工具调用都经过这个函数，把留痕放这一层谁都绕不过去。
// 被拒绝的调用同样记——那是唯一能看出「有人在尝试越权」的信号。

/**
 * 执行一次工具调用。
 * 权限、本地 / 媒体 / MCP 分流、错误兜底都在这里——
 * 错误一律转成文本回给模型，让它自己知道「这一步没做成」，
 * 而不是让整轮对话或整个工单崩掉。
 *
 * @param {{ key: string, actor?: string, send?: (payload: object) => Promise<void> }} ctx
 *   send 不传就没有媒体发送工具（没有会话上下文时发不出去）
 */
// 工具并发闸门：多个用户同时让我跑 shell 的话，会起一堆子进程把内存吃光
const toolLimiter = createLimiter('tool', env.toolConcurrency)

/** 给 /diag 看的工具并发状态 */
export function toolLimiterStats() {
  return toolLimiter.stats()
}

export async function runTool(name, args, { key, actor = '', send } = {}) {
  if (!isToolAllowed(name, actor)) {
    const reason = denyReason(name, actor)
    auditTool({ name, actor, sessionKey: key, args, outcome: 'denied', note: reason })
    return reason
  }

  if (env.toolDebug) {
    console.log(`[工具] ${name}(${JSON.stringify(args ?? {}).slice(0, 160)})`)
  }

  try {
    if (LOCAL_TOOL_NAMES.has(name)) {
      const handlers = makeLocalHandlers(key)
      return String(await handlers[name](args ?? {}))
    }

    if (GIT_TOOL_NAMES.has(name)) {
      const handlers = makeGitHandlers()
      return String(await handlers[name](args ?? {}))
    }

    if (SKILL_TOOL_NAMES.has(name)) {
      const handlers = makeSkillHandlers(key)
      return String(await handlers[name](args ?? {}))
    }

    if (PLAN_TOOL_NAMES.has(name)) {
      const handlers = makePlanHandlers(key)
      return String(await handlers[name](args ?? {}))
    }

    if (TODO_TOOL_NAMES.has(name)) {
      const handlers = makeTodoHandlers(key)
      return String(await handlers[name](args ?? {}))
    }

    if (MEDIA_TOOL_NAMES.has(name)) {
      if (!send) return `${name} 在当前场景不可用：没有会话上下文，发不出媒体`
      const handlers = makeMediaHandlers(send)
      const result = String(await handlers[name](args ?? {}))
      // 往外送文件是敏感通道，单独留痕
      auditSend({ name, actor, sessionKey: key, source: args?.source, outcome: 'ok' })
      return result
    }

    return await toolLimiter.run(() =>
      callTool(name, args ?? {}, env.toolTimeoutMs, { sessionKey: key, actor }),
    )
  } catch (error) {
    const message = String(error?.message ?? error)
    auditTool({ name, actor, sessionKey: key, args, outcome: 'failed', note: message.slice(0, 160) })
    return `${name} 调用失败：${message}`
  }
}
