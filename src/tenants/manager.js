import { createWechatClient } from '../channel/wechat.js'
import { log } from '../ops/logger.js'
import { credentialUsable, hasCredential, ilinkDirOf, listTenants } from './store.js'

// 租户管理器。
//
// 一个进程托管 N 个微信账号：每个账号一个 WeChatBot 实例，
// 各自的凭证目录、长轮询、context_token。
//
// 为什么共用一个进程而不是一个账号一个进程：
//   · MCP 工具服务只起一份，工具调用共享
//   · 调度器、巡检、记忆都只有一份，不用跨进程同步
//   · 单个进程崩溃只影响它自己，systemd 拉起来全部恢复

const clients = new Map() // tenantId -> client（已登录并启动的）
const sessions = new Map() // 登录会话：sid -> { tenantId, status, qr, error }

let onEvent = () => {}
let seq = 0

function nextSessionId() {
  seq += 1
  return `s${Date.now().toString(36)}${seq}`
}

/** 创建客户端并挂上统一的消息入口 */
function createClient(tenantId) {
  const client = createWechatClient({ tenantId, storageDir: ilinkDirOf(tenantId) })
  client.onMessage((event) => onEvent(event))
  return client
}

function launch(client) {
  // start() 会一直跑（长轮询），不能 await——await 就把启动卡死了
  client.start().catch((error) => {
    log.error(`[${client.tenantId}] 长轮询异常退出`, { error: error?.message ?? String(error) })
    clients.delete(client.tenantId)
  })
}

/**
 * 启动所有已登录的租户。
 *
 * 关键：先 login() 再 start()。SDK 的 start() 和所有发送都走 requireCredentials()，
 * 而凭证只有 login() 会从磁盘读进内存。少了这一步，重启后每个账号都起不来——
 * 现象就是「得去网页点一下重新扫码才能正常对话」：
 * 那条路径走的是 beginLogin()，里面先调了 login()，所以碰巧能work。
 *
 * @param {(event: object) => void} handler 统一消息入口
 */
export async function startAll(handler) {
  onEvent = handler

  const tenants = listTenants()
  const ready = tenants.filter((tenant) => credentialUsable(tenant.id))
  const broken = tenants.filter((tenant) => hasCredential(tenant.id) && !credentialUsable(tenant.id))
  const pending = tenants.filter((tenant) => !hasCredential(tenant.id))

  await Promise.all(
    ready.map(async (tenant) => {
      const client = createClient(tenant.id)
      try {
        // 只加载凭证，不弹二维码（SDK 发现磁盘有凭证就直接返回）
        await client.login()

        client.onLifecycle({
          expired: () => log.warn(`[租户] ${tenant.name} 会话过期了，需要重新扫码（去管理页面点「重新扫码」）`),
          restored: () => log.info(`[租户] ${tenant.name} 会话已恢复`),
        })

        clients.set(tenant.id, client)
        launch(client)
        log.info(`[租户] ${tenant.name}（${tenant.id}）已启动`)
      } catch (error) {
        clients.delete(tenant.id)
        log.error(`[租户] ${tenant.name} 启动失败，需要重新扫码`, {
          error: error?.message ?? String(error),
        })
      }
    }),
  )

  if (broken.length > 0) {
    log.warn(`[租户] ${broken.length} 个账号的凭证不可用，需要重新扫码：${broken.map((t) => t.name).join('、')}`)
  }
  if (pending.length > 0) {
    log.warn(
      `[租户] ${pending.length} 个账号还没登录：${pending.map((t) => t.name).join('、')}——打开 Web 页面扫码`,
    )
  }

  return { total: tenants.length, started: ready.length - broken.length, pending: pending.length + broken.length }
}

export function getClient(tenantId) {
  return clients.get(String(tenantId ?? '')) ?? null
}

export function startedTenants() {
  return [...clients.keys()]
}

/** 这个租户在不在跑 */
export function isRunning(tenantId) {
  return clients.has(String(tenantId ?? ''))
}

/**
 * 开始扫码登录。立即返回会话 id，二维码和状态通过 getSession() 轮询。
 * @returns {{sid: string, tenantId: string}}
 */
export function beginLogin(tenantId) {
  const id = String(tenantId ?? '').trim()
  if (!id) throw new Error('缺少租户 id')
  if (clients.has(id)) throw new Error('这个账号已经在登录状态了')

  const sid = nextSessionId()
  const session = { sid, tenantId: id, status: 'pending', qr: '', error: '', startedAt: Date.now() }
  sessions.set(sid, session)

  // 清理超过 10 分钟的会话记录
  for (const [key, item] of sessions) {
    if (Date.now() - item.startedAt > 10 * 60_000) sessions.delete(key)
  }

  const client = createClient(id)

  client
    .login({
      onQrUrl: (content) => {
        session.qr = String(content ?? '')
        session.status = 'wait'
      },
      onScanned: () => {
        session.status = 'scanned'
      },
      onExpired: () => {
        session.qr = ''
        session.status = 'expired'
      },
      onVerifyCode: () => {
        // 配对码流程需要人工输入，Web 场景下做不了，明确告知
        throw new Error('这个账号要求输入配对码，请在服务器终端里手动运行一次登录')
      },
    })
    .then(() => {
      session.status = 'confirmed'
      session.qr = ''
      clients.set(id, client)
      launch(client)
      log.info(`[租户] ${id} 登录成功并已开始轮询`)
    })
    .catch((error) => {
      session.status = 'failed'
      session.error = String(error?.message ?? error)
      log.error(`[租户] ${id} 登录失败`, { error: session.error })
    })

  return { sid, tenantId: id }
}

export function getSession(sid) {
  const session = sessions.get(String(sid ?? ''))
  if (!session) return null
  return {
    sid: session.sid,
    tenantId: session.tenantId,
    status: session.status,
    qr: session.qr,
    error: session.error,
  }
}

/** 停掉一个租户（删账号时用） */
export function stopTenant(tenantId) {
  const client = clients.get(String(tenantId ?? ''))
  if (!client) return false
  try {
    client.stop()
  } catch {
    // 已经停了
  }
  clients.delete(client.tenantId)
  return true
}

export function stopAll() {
  for (const client of clients.values()) {
    try {
      client.stop()
    } catch {
      // 单个停不掉不影响其他
    }
  }
  clients.clear()
}

/** 汇总状态，给 Web 和 /diag 用 */
export function tenantsStatus() {
  return listTenants().map((tenant) => {
    const client = clients.get(tenant.id)
    return {
      ...tenant,
      loggedIn: hasCredential(tenant.id),
      running: Boolean(client),
      selfId: client ? client.selfId() : '',
    }
  })
}
