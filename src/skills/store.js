import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config/paths.js'

// 技能：模型写给自己的做事说明。
//
// 和 QQ 版的区别在隔离：那边技能是全局的，因为只有一个用户。
// 我们多用户同跑，A 写的技能如果进 B 的提示词就是污染——
// 所以按会话（租户 + 用户）分目录，各看各的。
//
// 提示词里只放「名字 + 一句话」，全文要用 read_skill 按需读。
// 这样省 token，也让技能内容不直接占据系统提示的位置。

const skillsRoot = paths.skills
const MAX_SKILL_CHARS = 6000
const MAX_SKILLS = 30
const SUMMARY_MAX = 90

function dirOf(key) {
  const safe = String(key ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80)
  return path.join(skillsRoot, safe || 'unknown')
}

/** 技能名做文件名：去掉路径分隔符和 Windows 不允许的字符 */
export function safeName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
}

function fileOf(key, rawName) {
  const name = safeName(rawName)
  if (!name) return null
  return { name, file: path.join(dirOf(key), `${name}.md`) }
}

/** 从正文里抠出一句话描述：优先看有没有「适用场景」行，否则取第一行非标题 */
function summaryOf(body) {
  const lines = String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const scene = lines.find((line) => /^(适用场景|什么时候用|用途)[:：]/.test(line))
  if (scene) return scene.replace(/^(适用场景|什么时候用|用途)[:：]\s*/, '').slice(0, SUMMARY_MAX)

  const first = lines.find((line) => !line.startsWith('#'))
  return (first ?? '').slice(0, SUMMARY_MAX)
}

export function listSkills(key) {
  const dir = dirOf(key)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const list = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = path.join(dir, entry.name)
    try {
      const body = fs.readFileSync(file, 'utf8')
      const stat = fs.statSync(file)
      list.push({
        name: entry.name.replace(/\.md$/, ''),
        summary: summaryOf(body),
        chars: body.length,
        mtime: stat.mtimeMs,
      })
    } catch {
      // 单个读不了不影响其他
    }
  }

  return list.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SKILLS)
}

export function readSkill(key, rawName) {
  const target = fileOf(key, rawName)
  if (!target) return null
  try {
    return { name: target.name, body: fs.readFileSync(target.file, 'utf8') }
  } catch {
    return null
  }
}

export function writeSkill(key, rawName, content) {
  const target = fileOf(key, rawName)
  if (!target) throw new Error('技能名不合法：不能为空，也不能带路径分隔符')

  const body = String(content ?? '').trim()
  if (body.length < 10) throw new Error('技能内容太短了，至少写清「什么时候用」和「怎么一步步做」')

  const existed = fs.existsSync(target.file)
  fs.mkdirSync(path.dirname(target.file), { recursive: true })
  fs.writeFileSync(target.file, body.slice(0, MAX_SKILL_CHARS), 'utf8')

  return {
    name: target.name,
    existed,
    chars: Math.min(body.length, MAX_SKILL_CHARS),
    total: listSkills(key).length,
  }
}

export function deleteSkill(key, rawName) {
  const target = fileOf(key, rawName)
  if (!target) return false
  try {
    fs.rmSync(target.file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 提示词里的技能摘要。只给名字和一句话，全文让模型自己 read_skill。
 * @returns {string} 空串表示这个会话没有技能
 */
export function skillsPrompt(key) {
  const skills = listSkills(key)
  if (skills.length === 0) return ''

  const lines = ['【你给自己写的技能（要用时先 read_skill 读全文，别凭名字猜步骤）】']
  for (const item of skills) {
    lines.push(item.summary ? `- ${item.name}：${item.summary}` : `- ${item.name}`)
  }
  lines.push('技能是之前你按对方要求记下来的做事流程。跟当前请求对得上就按它做；对不上就当没看见，别硬套。')

  return lines.join('\n')
}
