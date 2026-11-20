import { describeSync, gitStatus, syncCode } from '../ops/git-sync.js'

// 代码同步工具。让模型能「现在就同步一次」或者「看看有没有没推的东西」。
// 定时同步是主进程里的定时器在跑，不经过模型；这个工具是手动补充。

export const GIT_TOOL_NAMES = new Set(['git_sync', 'git_status'])

export const GIT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'git_sync',
      description:
        '把本地改动提交并推送到远端，然后拉取远端更新合并。' +
        '只在对方明确说「同步一下代码」「把改动推上去」时用；定时同步已经由后台在跑，不用主动调。' +
        '有合并冲突时会中止并返回冲突文件，不替你解冲突。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '可选，提交说明。不传会用时间戳自动生成' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '看当前代码仓库状态：分支、有没有没提交的改动、领先或落后远端多少。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

export function makeGitHandlers() {
  return {
    git_sync: async ({ message } = {}) => {
      const report = await syncCode({ message })
      return `同步完成：${describeSync(report)}`
    },

    git_status: async () => {
      const status = await gitStatus()
      if (!status.ok) return status.reason

      const lines = [`分支 ${status.branch}`]
      if (!status.hasUpstream) lines.push('这个分支还没有 upstream')
      else {
        if (status.ahead > 0) lines.push(`本地领先远端 ${status.ahead} 个提交`)
        if (status.behind > 0) lines.push(`落后远端 ${status.behind} 个提交`)
        if (status.ahead === 0 && status.behind === 0) lines.push('和远端一致')
      }

      if (status.dirty) {
        lines.push(`有 ${status.files.length} 个文件没提交：`)
        lines.push(...status.files.slice(0, 15).map((line) => `  ${line}`))
        if (status.files.length > 15) lines.push(`  …还有 ${status.files.length - 15} 个`)
      } else {
        lines.push('工作区干净，没有未提交的改动')
      }

      return lines.join('\n')
    },
  }
}
