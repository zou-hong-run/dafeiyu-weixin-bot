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
const MAX_READ_CHARS = 12000
const MAX_SKILLS = 30
const SUMMARY_MAX = 90
// 技能库索引：迁移进来的技能包会带一份 SKILLS-INDEX.md，
// 里面是「目录名 + 一句话」，用它当图书馆的目录卡片。
const LIBRARY_INDEX = 'SKILLS-INDEX.md'

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

/**
 * 技能库（迁移进来的技能包）的目录解析：skills/<名字>/SKILL.md。
 * 名字必须干净——带 .. 或路径分隔符的一律拒绝，别让它跳出 skillsRoot。
 */
function libraryFileOf(rawName) {
  const name = String(rawName ?? '').trim()
  if (!name || name.includes('..') || /[\\/]/.test(name)) return null
  const file = path.join(skillsRoot, name, 'SKILL.md')
  if (!file.startsWith(skillsRoot + path.sep)) return null
  return { name, file }
}

let libraryCache = null

/** 技能库清单：扫 skills/<dir>/SKILL.md，带 mtime 缓存，避免每轮都 stat 四百个目录 */
function librarySkills() {
  const now = Date.now()
  if (libraryCache && now - libraryCache.at < 30000) return libraryCache.list

  let entries = []
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const list = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const file = path.join(skillsRoot, entry.name, 'SKILL.md')
    try {
      const stat = fs.statSync(file)
      list.push({ name: entry.name, file, chars: stat.size, mtime: stat.mtimeMs })
    } catch {
      // 没有 SKILL.md 的目录不算技能库成员
    }
  }

  list.sort((a, b) => a.name.localeCompare(b.name))
  libraryCache = { at: now, list }
  return list
}

/** 按关键词筛技能库，返回名字列表。空关键词返回全部名字 */
export function searchLibrary(query) {
  const q = String(query ?? '').trim().toLowerCase()
  const all = librarySkills().map((item) => item.name)
  if (!q) return all
  return all.filter((name) => name.toLowerCase().includes(q))
}

/**
 * 清掉技能库缓存。技能库是外部目录，批量导入后不等 30 秒自然过期。
 * 测试里改完目录也要调它，否则读到旧的。
 */
export function resetLibraryCache() {
  libraryCache = null
}

export function libraryCount() {
  return librarySkills().length
}

/** 技能库索引原文，有就返回，没有返回 null */
function libraryIndexBody() {
  try {
    return fs.readFileSync(path.join(skillsRoot, LIBRARY_INDEX), 'utf8')
  } catch {
    return null
  }
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
  const raw = String(rawName ?? '').trim()

  // 顺序：本会话自己写的技能 → 技能库里的目录 → 库索引
  const candidates = []
  if (target) candidates.push({ name: target.name, file: target.file, from: 'session' })
  const lib = libraryFileOf(raw)
  if (lib) candidates.push({ ...lib, from: 'library' })
  if (raw === LIBRARY_INDEX) {
    candidates.push({ name: 'SKILLS-INDEX', file: path.join(skillsRoot, LIBRARY_INDEX), from: 'index' })
  }

  for (const item of candidates) {
    try {
      let body = fs.readFileSync(item.file, 'utf8')
      if (body.length > MAX_READ_CHARS) {
        body = `${body.slice(0, MAX_READ_CHARS)}\n\n…（正文 ${body.length} 字，这里只给了前 ${MAX_READ_CHARS} 字，剩下的用 shell 看原文）`
      }
      return { name: item.name, body, from: item.from }
    } catch {
      // 试下一个
    }
  }

  return null
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
  const libCount = libraryCount()

  if (skills.length === 0 && libCount === 0) return ''

  const lines = ['【你给自己写的技能（要用时先 read_skill 读全文，别凭名字猜步骤）】']
  for (const item of skills) {
    lines.push(item.summary ? `- ${item.name}：${item.summary}` : `- ${item.name}`)
  }
  lines.push('技能是之前你按对方要求记下来的做事流程。跟当前请求对得上就按它做；对不上就当没看见，别硬套。')

  if (libCount > 0) {
    lines.push(
      `【本地技能库：${libCount} 个，放太多个进提示词会撑爆，所以只告诉你怎么取】`,
      `- 找技能：list_skills 带 query 关键词，比如 query=excel、query=投标，会返回名字列表`,
      `- 读技能：read_skill 传目录名，比如 read_skill name=docx，直接读 skills/<目录>/SKILL.md 全文`,
      `- 看总目录：read_skill name=${LIBRARY_INDEX}，里面有每个库技能的一句话说明`,
      `- 库技能可能带 scripts/ references/，需要跑脚本时用 shell 去 skills/<目录>/ 下找，别自己重写`,
    )
  }

  return lines.join('\n')
}
