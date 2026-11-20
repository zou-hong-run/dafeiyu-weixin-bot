import { deleteSkill, libraryCount, listSkills, readSkill, searchLibrary, writeSkill } from '../skills/store.js'

// 技能工具。放主进程而不是 MCP 子进程——
// 技能按会话隔离，需要拿到当前会话的 key，子进程没有这个概念。

export const SKILL_TOOL_NAMES = new Set(['write_skill', 'list_skills', 'read_skill', 'delete_skill'])

export const SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_skill',
      description:
        '把一套做事的流程记成技能，以后遇到同类任务会自动看到它的摘要。' +
        '对方说「学一下这个」「记住这套流程」「以后都按这个来」时用。' +
        '内容要写成能照着做的样子：什么时候用、第一步做什么、注意什么。只写长期有用的流程，一次性的操作别记。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名，如 周报整理 / 代码审查' },
          content: {
            type: 'string',
            description: '技能正文（Markdown）。开头写一行「适用场景：…」效果最好，会进摘要',
          },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description:
        '看有哪些技能。不带 query 只列这个会话里你自己写的技能；带 query 会顺带在本地技能库里按关键词搜目录名。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '可选关键词，如 excel / 投标 / pdf，按目录名模糊匹配',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description:
        '读某个技能的完整内容。提示词里只给了摘要，判断这个技能用得上时先读全文再照着做，别凭摘要猜步骤。' +
        'name 可以是本会话自己写的技能名，也可以是本地技能库里的目录名（如 docx / pdf），' +
        '还可以传 SKILLS-INDEX.md 读技能库总目录。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名或技能库目录名，如 周报整理 / docx / SKILLS-INDEX.md' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_skill',
      description: '删掉一个技能。对方说「那个流程别记了」时用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要删的技能名' },
        },
        required: ['name'],
      },
    },
  },
]

export function makeSkillHandlers(key) {
  return {
    write_skill: ({ name, content } = {}) => {
      const result = writeSkill(key, name, content)
      return `${result.existed ? '已更新' : '已记下'}技能「${result.name}」（${result.chars} 字，现在共 ${result.total} 个）。下一轮对话就能看到它。`
    },

    list_skills: ({ query } = {}) => {
      const skills = listSkills(key)
      const keyword = String(query ?? '').trim()
      const lines = []

      if (skills.length > 0) {
        lines.push(`本会话的技能 ${skills.length} 个：`)
        for (const item of skills) {
          lines.push(`- ${item.name}${item.summary ? `：${item.summary}` : ''}（${item.chars} 字）`)
        }
      }

      const matched = searchLibrary(keyword)
      const total = libraryCount()

      if (matched.length > 0) {
        // 不带关键词时可能几百个，全列会撑爆一条消息，所以只给数量 + 提示怎么搜
        const head = keyword
          ? `本地技能库匹配「${keyword}」的有 ${matched.length} 个`
          : `本地技能库共 ${total} 个`
        lines.push(`${head}：`)
        lines.push('  ' + matched.slice(0, 40).join('、') + (matched.length > 40 ? ` …（还有 ${matched.length - 40} 个，加关键词缩小范围）` : ''))
        lines.push('读法：read_skill 传目录名，比如 read_skill name=<上面的某个名字>')
      } else if (keyword) {
        lines.push(`本地技能库里没有匹配「${keyword}」的目录（共 ${total} 个）。换个关键词试试，或者 read_skill name=SKILLS-INDEX.md 看总目录。`)
      }

      if (lines.length === 0) return '这个会话还没有技能，本地技能库也是空的。用 write_skill 记一个。'
      return lines.join('\n')
    },

    read_skill: ({ name } = {}) => {
      const skill = readSkill(key, name)
      if (!skill) return `没有叫「${name}」的技能。用 list_skills 看看有哪些。`
      return `=== 技能：${skill.name} ===\n${skill.body}`
    },

    delete_skill: ({ name } = {}) => {
      return deleteSkill(key, name) ? `已删掉技能「${name}」。` : `没有叫「${name}」的技能。`
    },
  }
}
