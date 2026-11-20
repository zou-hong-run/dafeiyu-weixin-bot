import { submitPlan } from './plan.js'

// 规划模式的出口工具。语义同 Kimi Code 的 ExitPlanMode：
// 模型把方案交出来，等人的批准，批准前它依然只能读。

export const PLAN_TOOL_NAMES = new Set(['exit_plan_mode'])

export const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description:
        '把方案提交给对方过目。调用它表示「我规划完了」，不要再调用其他工具——这一轮到此结束。' +
        '方案要写成对方能直接看懂的样子：分几步、每步做什么、动到哪些文件、有什么风险。' +
        '不要在正文里问「要不要执行」，提交本身就是询问。',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: '完整方案正文，对方会原文看到。别写给自己看的过程笔记',
          },
        },
        required: ['plan'],
      },
    },
  },
]

export function makePlanHandlers(key) {
  return {
    exit_plan_mode: ({ plan } = {}) => {
      const body = String(plan ?? '').trim()
      if (!body) return '方案是空的，写点实质内容再提交'

      const saved = submitPlan(key, body)
      if (!saved) return '当前不在规划模式，没法提交方案'

      return '方案已提交，等对方确认。这一轮到此为止，不要再调用任何工具，也不用再说别的话。'
    },
  }
}
