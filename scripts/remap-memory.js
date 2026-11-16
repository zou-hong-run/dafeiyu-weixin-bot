import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 把记忆里的会话从一个账号 id 挪到另一个。
//
// 什么时候需要：账号被删了（凭证跟着删）又重新扫码，新账号的 id 和旧的
// 不一样。会话键是 <tenantId>:user:<userId>，id 变了就找不到旧记忆。
//
// 用法：node scripts/remap-memory.js <旧id> <新id>
// 先跑 `ls data/tenants` 看现在有哪些 id。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const memoryFile = path.join(projectRoot, 'data', 'memory.json')

const [oldId, newId] = process.argv.slice(2).map((item) => String(item ?? '').trim())

if (!oldId || !newId) {
  console.error('用法：node scripts/remap-memory.js <旧账号id> <新账号id>')
  console.error('先跑 ls data/tenants 看当前有哪些账号 id')
  process.exit(1)
}

if (oldId === newId) {
  console.error('新旧 id 一样，不用迁')
  process.exit(1)
}

let data
try {
  data = JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
} catch (error) {
  console.error('读不到 data/memory.json：', error?.message ?? error)
  process.exit(1)
}

const from = `${oldId}:user:`
const to = `${newId}:user:`
const sessions = data.sessions ?? {}

let moved = 0
let skipped = 0

for (const key of Object.keys(sessions)) {
  if (!key.startsWith(from)) continue

  const next = to + key.slice(from.length)
  if (sessions[next]) {
    // 目标已经有了，不覆盖——那边可能已经聊过新内容
    skipped += 1
    continue
  }

  sessions[next] = sessions[key]
  delete sessions[key]
  moved += 1
}

if (moved === 0) {
  console.log(`没有找到 ${oldId} 名下的会话（可能已经迁过，或者 id 写错了）`)
  const keys = Object.keys(sessions)
  if (keys.length > 0) console.log('当前会话键：\n  ' + keys.join('\n  '))
  process.exit(0)
}

fs.mkdirSync(path.dirname(memoryFile), { recursive: true })
const tmp = `${memoryFile}.tmp`
fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
fs.renameSync(tmp, memoryFile)

console.log(`已迁移 ${moved} 个会话：${oldId} → ${newId}`)
if (skipped > 0) console.log(`跳过 ${skipped} 个（目标账号下已有同名会话，没覆盖）`)
console.log('重启机器人后生效。')
