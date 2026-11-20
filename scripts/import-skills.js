#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from '../src/config/paths.js'
import { listTenants } from '../src/tenants/store.js'
import { listSkills, writeSkill } from '../src/skills/store.js'

// 从旧项目导入技能。
//
// 旧格式两种布局：skills/xxx.md 和 skills/xxx/SKILL.md；
// 开头可能有 frontmatter（name / description / when-to-use / inject）。
// 我们这边简化成「文件名 = 技能名，正文第一行尽量写 `适用场景：…`」，
// 所以要把 when-to-use / description 折成那一行，正文照搬。
//
// 用法：
//   node scripts/import-skills.js --from ../qq/robot/skills --dry-run
//   node scripts/import-skills.js --from ../qq/robot/skills
//   node scripts/import-skills.js --from <dir> --key <租户id>:user:<用户id>
//
// 不给 --key 时自动推断：只有一个账号、且该账号下只有一个对话人时直接用。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { from: '', key: '', dryRun: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--from') out.from = argv[++i] ?? ''
    else if (arg === '--key') out.key = argv[++i] ?? ''
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--force') out.force = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function usage() {
  console.log(`用法：
  node scripts/import-skills.js --from <旧技能目录> [--key <会话键>] [--dry-run] [--force]

  --from    旧项目的 skills 目录（默认 ../qq/robot/skills）
  --key     目标会话键，形如 租户id:user:用户id。不给就自动推断
  --dry-run 只列出会导入什么，不写文件
  --force   同名技能已存在时覆盖（默认跳过）`)
}

/** 拆 frontmatter，把 when-to-use / description 折成正文第一行 */
function convert(raw) {
  const matched = String(raw ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  let body = String(raw ?? '')
  const meta = {}

  if (matched) {
    body = body.slice(matched[0].length)
    for (const line of matched[1].split(/\r?\n/)) {
      const hit = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/)
      if (!hit) continue
      meta[hit[1].toLowerCase()] = hit[2].trim().replace(/^["']|["']$/g, '')
    }
  }

  const trimmed = body.trim()
  const scene = meta['when-to-use'] || meta.when || meta.description || ''

  // 正文里已经写了适用场景就别再叠一行
  if (!scene || /^(适用场景|什么时候用|用途)[:：]/.test(trimmed)) return trimmed
  return `适用场景：${scene}\n\n${trimmed}`
}

/** 收集旧目录里的技能（兼容单文件和子目录两种布局） */
function collect(fromDir) {
  const items = []

  let entries = []
  try {
    entries = fs.readdirSync(fromDir, { withFileTypes: true })
  } catch {
    return items
  }

  for (const entry of entries) {
    const full = path.join(fromDir, entry.name)

    if (entry.isFile() && entry.name.endsWith('.md')) {
      items.push({ name: entry.name.replace(/\.md$/, ''), file: full })
      continue
    }

    if (entry.isDirectory()) {
      const skillFile = path.join(full, 'SKILL.md')
      if (fs.existsSync(skillFile)) items.push({ name: entry.name, file: skillFile })
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name))
}

/** 只有一个账号、且该账号下只有一个对话人时，直接用它 */
function inferKey() {
  const tenants = listTenants()
  if (tenants.length !== 1) {
    return { error: `有 ${tenants.length} 个账号，没法自动判断技能归谁，请用 --key 指定` }
  }

  const tenantId = tenants[0].id
  let memory = {}
  try {
    memory = JSON.parse(fs.readFileSync(path.join(paths.data, 'memory.json'), 'utf8')).sessions ?? {}
  } catch {
    memory = {}
  }

  const prefix = `${tenantId}:user:`
  const users = new Set(
    Object.keys(memory)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  )

  if (users.size !== 1) {
    return { error: `账号「${tenants[0].name}」下有 ${users.size} 个对话人，请用 --key 指定` }
  }

  return { key: `${tenantId}:user:${[...users][0]}`, tenantName: tenants[0].name }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}

const fromDir = path.resolve(projectRoot, args.from || path.join('..', 'qq', 'robot', 'skills'))

if (!fs.existsSync(fromDir)) {
  console.error(`旧技能目录不存在：${fromDir}`)
  console.error('用 --from 指定实际位置（比如从服务器拷下来的目录）')
  process.exit(1)
}

const items = collect(fromDir)
if (items.length === 0) {
  console.log(`${fromDir} 里没有找到技能（既没有 *.md，也没有 */SKILL.md）`)
  process.exit(0)
}

let targetKey = args.key.trim()
if (!targetKey) {
  const inferred = inferKey()
  if (inferred.error) {
    console.error(inferred.error)
    console.error('先看看有哪些账号：node -e "import(\'./src/tenants/store.js\').then(m=>console.log(m.listTenants()))"')
    process.exit(1)
  }
  targetKey = inferred.key
  console.log(`目标会话：${targetKey}（自动推断）`)
}

const existing = new Set(listSkills(targetKey).map((item) => item.name))
let created = 0
let updated = 0
let skipped = 0

console.log(`\n从 ${fromDir} 导入 ${items.length} 个技能 → ${targetKey}\n`)

for (const item of items) {
  const exists = existing.has(item.name)

  if (exists && !args.force) {
    console.log(`  跳过 ${item.name}（已存在，加 --force 覆盖）`)
    skipped += 1
    continue
  }

  const content = convert(fs.readFileSync(item.file, 'utf8'))
  if (!content || content.length < 10) {
    console.log(`  跳过 ${item.name}（正文太短，导入也是空的）`)
    skipped += 1
    continue
  }

  if (args.dryRun) {
    console.log(`  [预演] ${exists ? '覆盖' : '新建'} ${item.name}（${content.length} 字）`)
    continue
  }

  const result = writeSkill(targetKey, item.name, content)
  console.log(`  ${result.existed ? '已覆盖' : '已导入'} ${result.name}（${result.chars} 字）`)
  if (result.existed) updated += 1
  else created += 1
}

if (args.dryRun) {
  console.log('\n预演结束，没有写任何文件。去掉 --dry-run 才会真的导入。')
} else {
  console.log(`\n完成：新建 ${created}，覆盖 ${updated}，跳过 ${skipped}`)
  console.log('技能的生效范围是具体的「账号 + 对话人」，别人看不到这些技能。')
}
