import http from 'node:http'
import QRCode from 'qrcode'
import { env } from '../config/env.js'
import { log } from '../ops/logger.js'
import { createTenant, getTenant, removeTenant } from '../tenants/store.js'
import { beginLogin, getSession, stopTenant, tenantsStatus } from '../tenants/manager.js'
import { pageHtml } from './page.js'

// 多账号管理页面。
//
// 安全默认：只听 127.0.0.1。要放到公网必须自己设 WEB_ACCESS_TOKEN——
// 否则任何人都能往你的机器人里塞一个账号，然后用它执行命令。
//
// 二维码在服务端生成 SVG（qrcode 包，纯 JS），页面不需要任何外部资源。

const MAX_BODY = 1024 * 1024
let server = null

function isLocal(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function authOk(req, url) {
  if (!env.webAccessToken) return true
  if (req.headers['x-access-token'] === env.webAccessToken) return true
  return url.searchParams.get('token') === env.webAccessToken
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 二维码内容 → SVG。协议给的是跳转链接；万一给的是图片就转 data URI */
async function qrSvgOf(content) {
  const value = String(content ?? '')
  if (!value) return ''

  if (/^https?:\/\//i.test(value)) {
    return QRCode.toString(value, { type: 'svg', margin: 1, width: 240 })
  }

  const base64 = value.replace(/^data:image\/[a-z]+;base64,/i, '')
  if (/^[A-Za-z0-9+/=\s]{100,}$/.test(base64)) {
    return `<img src="data:image/png;base64,${base64}" width="240" height="240" alt="二维码">`
  }

  return ''
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  if (!authOk(req, url)) {
    sendJson(res, 401, { error: '需要访问令牌' })
    return
  }

  // 页面
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const html = pageHtml({ token: env.webAccessToken })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }

  // 账号列表
  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, { tenants: tenantsStatus() })
    return
  }

  // 新建账号并开始扫码
  if (req.method === 'POST' && path === '/api/tenants') {
    const body = await readBody(req)
    const tenant = createTenant({ name: body.name })
    const { sid } = beginLogin(tenant.id)
    log.info(`[web] 新建账号 ${tenant.name}（${tenant.id}），等待扫码`)
    sendJson(res, 200, { tenant, sessionId: sid })
    return
  }

  // 重新扫码
  const loginMatch = /^\/api\/tenants\/([^/]+)\/login$/.exec(path)
  if (req.method === 'POST' && loginMatch) {
    const id = decodeURIComponent(loginMatch[1])
    if (!getTenant(id)) {
      sendJson(res, 404, { error: '没有这个账号' })
      return
    }
    const { sid } = beginLogin(id)
    sendJson(res, 200, { sessionId: sid })
    return
  }

  // 删除账号
  const oneMatch = /^\/api\/tenants\/([^/]+)$/.exec(path)
  if (req.method === 'DELETE' && oneMatch) {
    const id = decodeURIComponent(oneMatch[1])
    stopTenant(id)
    removeTenant(id)
    log.info(`[web] 已删除账号 ${id}`)
    sendJson(res, 200, { ok: true })
    return
  }

  // 登录会话状态（含二维码）
  const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(path)
  if (req.method === 'GET' && sessionMatch) {
    const session = getSession(decodeURIComponent(sessionMatch[1]))
    if (!session) {
      sendJson(res, 404, { error: '会话不存在或已过期' })
      return
    }
    const qrSvg = session.qr ? await qrSvgOf(session.qr) : ''
    sendJson(res, 200, { ...session, qrSvg })
    return
  }

  sendJson(res, 404, { error: '没有这个接口' })
}

export function startWebServer() {
  if (!env.webEnabled) {
    log.info('[web] 管理页面已关闭（WEB_ENABLED=false）')
    return null
  }

  const localOnly = isLocal(env.webHost)
  if (!localOnly && !env.webAccessToken) {
    log.error(
      `[web] 拒绝启动：监听 ${env.webHost} 却没设 WEB_ACCESS_TOKEN。` +
        '对外开放的管理页面等于把机器人交出去——要么只用 127.0.0.1，要么配一个令牌。',
    )
    return null
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.warn('[web] 请求处理失败', { error: error?.message ?? String(error) })
      if (!res.headersSent) sendJson(res, 500, { error: error?.message ?? '服务器错误' })
    })
  })

  server.on('error', (error) => {
    log.error(`[web] 监听 ${env.webHost}:${env.webPort} 失败`, { error: error?.message ?? String(error) })
  })

  server.listen(env.webPort, env.webHost, () => {
    const hint = env.webAccessToken ? '（访问时在地址后加 ?token=<你在 WEB_ACCESS_TOKEN 配的那串>）' : ''
    log.info(`[web] 管理页面 http://${env.webHost}:${env.webPort}/${hint}`)
    if (!localOnly) {
      log.warn(`[web] 正在监听 ${env.webHost}（非本地）。确认防火墙只放行了该放行的来源。`)
    }
  })

  return server
}

export function stopWebServer() {
  if (!server) return
  try {
    server.close()
  } catch {
    // 已经关了
  }
  server = null
}
