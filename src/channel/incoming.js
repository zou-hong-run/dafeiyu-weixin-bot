import fs from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// 入站附件：图片 / 文件 / 视频下载落盘，语音只取平台转写。
//
// 微信协议里所有媒体都加密在 CDN 上（AES-128-ECB），解密由 SDK 的 downloadRaw 处理。
// 这里只管三件事：下载、命名、给模型一段能看懂的说明。

const incomingRoot = path.join(env.projectRoot, 'downloads', 'incoming')

const MAX_ITEMS = 4
const MAX_BYTES = 20 * 1024 * 1024
const KIND_LABEL = { image: '图片', voice: '语音', video: '视频', file: '文件' }

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** 文件头嗅探：扩展名缺失时也能认出是不是图片 */
function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return ''
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return '.png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg'
  if (buffer.slice(0, 3).toString() === 'GIF') return '.gif'
  if (buffer.slice(8, 12).toString() === 'WEBP') return '.webp'
  return ''
}

export function mimeOf(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase()
  return IMAGE_MIME[ext] ?? ''
}

function scopeDirOf(scopeKey) {
  const safe = String(scopeKey ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  return path.join(incomingRoot, safe)
}

function safeName(item, index, ext) {
  const raw = String(item.name ?? '')
  const base = raw
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 20)
  return `${Date.now()}-${index}-${base || item.type}${ext}`
}

async function downloadOne(client, item, index, dir) {
  // 语音不下载：内容只在平台转写里，本机没有 SILK 解码引擎
  if (item.type === 'voice') return { ...item, file: '', skipped: true }
  if (!item.media) return { ...item, error: '没有 CDN 引用' }
  if (item.size > MAX_BYTES) return { ...item, error: `超过 ${MAX_BYTES / 1048576}MB，没有下载` }

  try {
    fs.mkdirSync(dir, { recursive: true })
    const buffer = await client.downloadRaw(item.media, item.aeskey)
    if (buffer.length > MAX_BYTES) return { ...item, error: '下载后超过大小上限' }

    // 声明成 image 但文件头不是图片：说明对方发的是别的东西，别硬喂给视觉模型
    let type = item.type
    const sniffed = sniffImageExt(buffer)
    if (sniffed && type !== 'image') type = 'image'
    if (!sniffed && type === 'image') type = 'file'

    const ext = sniffed || path.extname(String(item.name ?? '')).toLowerCase().slice(0, 6)
    const file = path.join(dir, safeName({ ...item, type }, index, ext))
    fs.writeFileSync(file, buffer)

    return {
      ...item,
      type,
      size: buffer.length,
      file: path.relative(env.projectRoot, file).split(path.sep).join('/'),
    }
  } catch (error) {
    return { ...item, error: String(error?.message ?? error).slice(0, 100) }
  }
}

/**
 * 下载并整理成给模型看的说明。
 * 返回的 images 是本地图片路径，调用方会转成 base64 送进视觉通道。
 */
export async function describeInbound(client, items, scopeKey = '') {
  if (!Array.isArray(items) || items.length === 0) return { text: '', images: [] }

  const dir = scopeDirOf(scopeKey)
  const downloaded = await Promise.all(
    items.slice(0, MAX_ITEMS).map((item, index) => downloadOne(client, item, index, dir)),
  )
  const lines = []
  const images = []

  for (const item of downloaded) {
    const label = KIND_LABEL[item.type] ?? item.type

    if (item.type === 'voice') {
      lines.push(
        item.text
          ? `[语音] 平台已转成文字：「${item.text}」`
          : '[语音] 平台没给转写文字，这条内容我拿不到',
      )
      continue
    }

    if (item.file) {
      lines.push(`[${label}] 已存到 ${item.file}${item.size ? `（${(item.size / 1024).toFixed(0)} KB）` : ''}`)
      if (item.type === 'image') images.push(item.file)
    } else {
      lines.push(`[${label}] ${item.error ?? '没有拿到下载地址'}`)
    }
  }

  return { text: lines.join('\n'), images }
}

/** 入站附件按 mtime 定期清理 */
export function cleanupIncoming(ttlHours = 24) {
  if (!(ttlHours > 0)) return 0

  const ttlMs = ttlHours * 3600 * 1000
  const now = Date.now()
  let removed = 0

  const walk = (dir, depth = 0) => {
    if (depth > 2) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      try {
        if (now - fs.statSync(full).mtimeMs <= ttlMs) continue
        fs.rmSync(full, { force: true })
        removed += 1
      } catch {
        // 单个删不掉不影响其他
      }
    }
  }

  walk(incomingRoot)
  return removed
}
