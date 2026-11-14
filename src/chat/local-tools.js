import { addLongTerm, forget, listLongTerm, recallLongTerm, reset } from '../memory/memory.js'

// 本地工具：记忆类。
//
// 这些不走 MCP —— 它们要读写主进程里的 memory.json，起子进程反而多一层。
// 形状和 MCP 工具保持一致（OpenAI function 格式），对话循环不用区分来源。

export const LOCAL_TOOL_NAMES = new Set([
  'remember',
  'recall_memory',
  'list_memory',
  'forget_memory',
  'clear_memory',
])

export const LOCAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把值得长期记住的信息写入记忆，比如对方的身份、职业、偏好、正在做的项目、明确的约定。' +
        '只在信息长期有用时调用，寒暄和一次性内容不要记。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话事实，如「对方是做前端的，主要在写 React」' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '按关键词从长期记忆里找相关条目。对方提到以前说过的事、而你不确定时用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，如「前端」「项目名」' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memory',
      description: '列出长期记忆里记了哪些内容。对方问「你都记得我什么」时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_memory',
      description:
        '按关键词删掉长期记忆里包含这个词的条目，不动别的记忆。' +
        '对方说「忘掉关于 X 的事」时用；要清空全部记忆用 clear_memory。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要忘掉的关键词，如「前公司」' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_memory',
      description:
        '清空当前会话的全部记忆（短期、摘要、长期）。对方说「忘掉之前的事」「重新开始」时用。' +
        '这个操作不可逆。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

/** 每个会话一份 handler，拦住 key 不让模型自己指定 */
export function makeLocalHandlers(key) {
  return {
    remember: ({ text } = {}) => {
      const clean = String(text ?? '').trim()
      if (!clean) throw new Error('text 不能为空')
      return addLongTerm(key, clean) ? `已记住：${clean}` : '这条已经记过了，没重复记。'
    },

    recall_memory: ({ query } = {}) => {
      const hits = recallLongTerm(key, String(query ?? ''))
      if (hits.length === 0) return '长期记忆里没有相关的条目。'
      return hits.map((item, index) => `${index + 1}. ${item.text}`).join('\n')
    },

    list_memory: () => {
      const items = listLongTerm(key, 50)
      if (items.length === 0) return '长期记忆还是空的。'
      return items.map((text, index) => `${index + 1}. ${text}`).join('\n')
    },

    forget_memory: ({ keyword } = {}) => {
      const word = String(keyword ?? '').trim()
      if (!word) throw new Error('keyword 不能为空')
      const removed = forget(key, word)
      if (removed.length === 0) return `没有含「${word}」的记忆条目。`
      return `删掉了 ${removed.length} 条：\n${removed.map((text) => `- ${text}`).join('\n')}`
    },

    clear_memory: () => {
      reset(key)
      return '记忆已清空。'
    },
  }
}
