import { env } from '../config/env.js'
import { tenantIdOf, userIdOf } from '../tenants/keys.js'
import { addSchedule, listSchedules, nextMatchOf, removeSchedule } from '../tasks/scheduler.js'

// 定时任务工具。放主进程，理由和技能一样：任务归属按会话隔离，
// 推送目标要从当前会话的 key 反解出来，MCP 子进程没有这个概念。
//
// 为什么要有这套：只有 `/schedule` 命令时，模型只能回一句「你自己发个命令」——
// 对方说「每天早上八点半提醒我」它明明能做到，却把活推回给人。
// 现在它自己就能加，条件是对方明确要一个「到点自动做的事」，不是随口一说。

export const SCHEDULE_TOOL_NAMES = new Set(['schedule_task', 'list_schedule', 'remove_schedule'])

// 推送门控的真实限制：闲置超过这个分钟数，token 大概率已失效，调度层会直接放弃
const PUSH_WINDOW = env.pushMaxIdleMinutes

export const SCHEDULE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        '给对方加一个定时任务：到点自动跑一段任务，结果直接发给他。' +
        '对方说「每天早上提醒我」「每周一帮我整理一下」这类明确要求定时的事时用，别自己主动加。' +
        'cron 是五段（分 时 日 月 周），如 30 8 * * * = 每天 8:30。' +
        'prompt 要写成「到点该做什么」的完整交代：执行时没有对话上下文，写「提醒他吃药」而不是「提醒一下」。' +
        '同一个时间别重复加，加之前先用 list_schedule 看一眼。' +
        `注意：到点时对方如果超过 ${PUSH_WINDOW} 分钟没说过话，推送会失败——加完要把这条告诉他。`,
      parameters: {
        type: 'object',
        properties: {
          cron: { type: 'string', description: '五段 cron：分 时 日 月 周，如 30 8 * * *' },
          prompt: {
            type: 'string',
            description: '到点要做什么，写成自包含的交代。没事可说时输出 SILENT 就不会推送',
          },
        },
        required: ['cron', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedule',
      description: '看这个会话有哪些定时任务，含 cron、下次触发时间和任务描述。加任务前或对方问「我设了些什么」时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_schedule',
      description: '删掉一个定时任务。id 从 list_schedule 拿。只能删自己建的和自己是管理员的。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id，形如 sched-xxxx' },
        },
        required: ['id'],
      },
    },
  },
]

export function makeScheduleHandlers(key, { actor = '', isAdmin = false } = {}) {
  // 推送目标只能是当前会话自己的主人：模型改不了这个，也就不可能拿它去骚扰别人
  const userId = userIdOf(key)
  const tenantId = tenantIdOf(key)

  return {
    schedule_task: ({ cron, prompt } = {}) => {
      if (!userId) return '拿不到这个会话的用户 id，没法建定时任务。让对方先发一条普通消息再试。'

      const before = listSchedules(key).length
      const task = addSchedule({
        sessionKey: key,
        target: { type: 'user', id: userId, tenantId },
        cron,
        prompt,
        createdBy: actor || userId,
      })

      const lines = [
        `定时任务 ${task.id} 已加：${task.cron}（${task.when}），下次 ${nextMatchOf(task.cron) ?? '解析失败'}。`,
      ]

      // 重复的上限是 5 个，撞上来时提醒一句，别以为是新加的
      if (before >= 5) lines.push('注意：这个会话的任务已经到上限了，再加会被拒。')
      lines.push(
        `提醒：到点推送要求对方在 ${PUSH_WINDOW} 分钟内说过话，否则 token 失效发不出去——` +
          '把这条转告他，让他到点前随手发一句，或者把时间挪到他本来就会说话的点。',
      )
      return lines.join('\n')
    },

    list_schedule: () => {
      const list = listSchedules(key)
      if (list.length === 0) return '这个会话还没有定时任务。'

      return list
        .map(
          (item) =>
            `${item.id}｜${item.cron}｜${item.enabled ? '启用' : '停用'}｜下次 ${item.nextAt ?? '解析失败'}\n   ${item.prompt}`,
        )
        .join('\n')
    },

    remove_schedule: ({ id } = {}) => {
      const taskId = String(id ?? '').trim()
      if (!taskId) return '用法：remove_schedule id=<任务 id>，id 用 list_schedule 查'

      const removed = removeSchedule(taskId, key, { actor, isAdmin })
      return `已删掉 ${removed.id}（${removed.cron}：${removed.prompt.slice(0, 40)}）。`
    },
  }
}
