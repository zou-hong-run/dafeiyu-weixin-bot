import fs from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// 租户注册表。
//
// 一个租户 = 一个微信账号 + 这套机器人的一份实例。
// 目录结构：
//   data/tenants/<id>/meta.json     名称、创建时间
//   data/tenants/<id>/ilink/        登录凭证、context_token、游标
//
// 为什么要按账号分目录：SDK 的凭证是按 storageDir 存的，
// 两个账号共用同一个目录会互相覆盖 token——A 的回复会发到 B 的会话里。

const tenantsRoot = path.join(env.projectRoot, 'data', 'tenants')

function safeId(raw) {
  return String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 32)
}

function metaFile(id) {
  return path.join(tenantsRoot, id, 'meta.json')
}

export function tenantDir(id) {
  return path.join(tenantsRoot, safeId(id))
}

export function ilinkDirOf(id) {
  return path.join(tenantDir(id), 'ilink')
}

/** 列出所有租户，按创建时间排 */
export function listTenants() {
  let dirs = []
  try {
    dirs = fs.readdirSync(tenantsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }

  const list = []
  for (const entry of dirs) {
    const id = safeId(entry.name)
    if (!id) continue
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'))
      list.push({ id, name: String(meta.name ?? id), createdAt: Number(meta.createdAt) || 0 })
    } catch {
      // meta 坏了也认，用目录名当名字
      list.push({ id, name: id, createdAt: 0 })
    }
  }

  return list.sort((a, b) => a.createdAt - b.createdAt)
}

export function getTenant(id) {
  const clean = safeId(id)
  if (!clean) return null
  return listTenants().find((item) => item.id === clean) ?? null
}

/**
 * 新建租户。id 由名字生成，冲突了加序号。
 * @returns {{id: string, name: string, createdAt: number}}
 */
export function createTenant({ name, id: fixedId } = {}) {
  const label = String(name ?? '').trim().slice(0, 40) || '新账号'

  // 上限保护。没有这个的话页面能一直加，加到内存爆、进程被 OOM 杀掉——
  // 而且现场看起来是「所有账号一起失联」，查起来很费劲。
  const existing = listTenants()
  if (existing.length >= env.maxTenants) {
    throw new Error(
      `账号数已达上限 ${env.maxTenants} 个。要接更多，调大 MAX_TENANTS 并确认内存够用（每个账号常驻一条长轮询）`,
    )
  }

  // 用名字的字母数字部分当 id，中文会变空，那就用时间戳
  // 迁移旧的单账号数据时用固定 id，这样记忆里的会话键能一次性对上
  let base = safeId(fixedId) || safeId(label.toLowerCase().replace(/\s+/g, '-'))
  if (!base) base = `wx-${Date.now().toString(36)}`

  let id = base
  let seq = 1
  while (fs.existsSync(tenantDir(id))) {
    id = `${base}-${seq++}`
    if (seq > 50) throw new Error('租户 id 冲突太多，换个名字')
  }

  const meta = { id, name: label, createdAt: Date.now() }
  fs.mkdirSync(ilinkDirOf(id), { recursive: true, mode: 0o700 })
  fs.writeFileSync(metaFile(id), JSON.stringify(meta, null, 2), { mode: 0o600 })

  return meta
}

export function renameTenant(id, name) {
  const tenant = getTenant(id)
  if (!tenant) throw new Error(`没有这个租户：${id}`)
  const label = String(name ?? '').trim().slice(0, 40)
  if (!label) throw new Error('名字不能为空')

  const meta = { ...tenant, name: label }
  fs.writeFileSync(metaFile(tenant.id), JSON.stringify(meta, null, 2), { mode: 0o600 })
  return meta
}

/** 删租户：连凭证一起删，删了要重新扫码 */
export function removeTenant(id) {
  const clean = safeId(id)
  if (!clean) throw new Error('租户 id 不合法')
  fs.rmSync(tenantDir(clean), { recursive: true, force: true })
  return clean
}

/**
 * 从单账号时代迁移。
 *
 * 老版本把凭证放在 data/ilink/。如果那里有凭证、又还没有任何租户，
 * 就自动建一个 default 租户并把目录搬过去——不用重新扫码。
 */
export function migrateLegacyCredential() {
  const legacy = path.join(env.projectRoot, 'data', 'ilink')
  if (!fs.existsSync(path.join(legacy, 'credentials.json'))) return null
  if (listTenants().length > 0) return null

  const meta = createTenant({ name: '默认账号', id: 'default' })
  const target = ilinkDirOf(meta.id)

  try {
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name)
      const to = path.join(target, name)
      try {
        fs.renameSync(from, to)
      } catch {
        // 跨设备 rename 会失败，退回拷贝
        fs.copyFileSync(from, to)
        fs.rmSync(from, { force: true })
      }
    }
    fs.rmSync(legacy, { recursive: true, force: true })
    console.log(`[租户] 已把旧的单账号凭证迁移到「${meta.name}」`)
  } catch (error) {
    console.error('[租户] 迁移旧凭证失败：', error?.message ?? error)
  }

  return meta
}

/** 有没有登录过（凭证存在） */
export function hasCredential(id) {
  try {
    return fs.existsSync(path.join(ilinkDirOf(id), 'credentials.json'))
  } catch {
    return false
  }
}
