import { getTodos, renderTodos, setTodos, todoProgress } from './todos.js'

// 任务清单工具。提示词和语义搬自 Kimi Code 的 TodoList 工具
// （packages/agent-core-v2/src/features/todo/tools/todo-list/todo-list.md）。

export const TODO_TOOL_NAMES = new Set(['todo_write'])

export const TODO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '维护当前任务清单。多步的活靠它防止跑偏。' +
        '**什么时候用**：三步以上、要跨多轮工具调用、或接到一段有多个要求的新指令时。' +
        '**什么时候别用**：一两步就能答完的、纯闲聊、记了也不增加清晰度的，别建清单——建了又不管比不建更糟。' +
        '**怎么用**：每次传完整清单（覆盖旧的），不是只传改动的那一项；不传 todos 表示只看当前清单；传空数组清空。' +
        'status 只有三种：pending / in_progress / done。开工时把**恰好一项**标成 in_progress，做完立刻标 done，别攒到最后一起改。' +
        '**不许假完成**：工具还失败着、实现只做了一半、有没解决的报错——这些都不能标 done。' +
        '卡住了就把那一项留在 in_progress，或者加一条 pending 写清「必须先解决什么」。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整清单，最多 30 项。不传=只看，传空数组=清空',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '这一步做什么，20 字以内' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done'],
                  description: 'pending / in_progress / done',
                },
              },
              required: ['title', 'status'],
            },
          },
        },
      },
    },
  },
]

export function makeTodoHandlers(key) {
  return {
    todo_write: ({ todos } = {}) => {
      // 不传就是看一眼，不动清单
      if (todos === undefined) {
        const current = getTodos(key)
        if (current.length === 0) return '清单是空的。'
        const { done, total } = todoProgress(current)
        return `当前 ${done}/${total} 完成\n${renderTodos(current)}`
      }

      const list = setTodos(key, todos)
      if (list.length === 0) return '清单已清空。'

      const { done, total, inProgress } = todoProgress(list)
      const head =
        inProgress.length > 0
          ? `清单已更新（${done}/${total} 完成），当前在做「${inProgress[0].title}」`
          : `清单已更新（${done}/${total} 完成）`

      return `${head}\n${renderTodos(list, '')}`
    },
  }
}
