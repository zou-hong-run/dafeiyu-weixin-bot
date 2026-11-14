import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { segment } from '../channel/wechat.js'
import { env } from '../config/env.js'
import { sensitiveReason } from '../ops/file-policy.js'
import { assertPublicUrlResolved } from '../mcp-server/net-guard.js'

// 媒体发送工具：图片 / 文件 / 视频 / 音频。
//
// 微信没有语音消息（SDK 的 MessageBuilder 只有 text/image/file/video），
// 所以音频走「文件」通道：转成 mp3 再发，对方点开就能播。
//
// 能做到「把文件发出去」就意味着能把项目里的任何东西外发，
// 所以本地路径必须先过敏感路径检查——data/（别人的对话和记忆）、
// .env（密钥）、logs/、backups/ 全在黑名单里。

const run = promisify(execFile)

const FFMPEG = process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.opus', '.wma'])

export const MEDIA_TOOL_NAMES = new Set(['send_image', 'send_file', 'send_video', 'send_audio'])

/**
 * 校验能不能发这个来源。
 * URL 放过（不是本地数据）；本地路径必须在项目内且不在敏感目录。
 * @returns {string} 相对路径，URL 返回空串
 */
function assertSendable(source) {
  const text = String(source ?? '').trim()
  if (!text) throw new Error('source 不能为空')

  if (/^https?:\/\//i.test(text)) {
    // URL 只挡内网地址：否则模型能拿它探本机和局域网
    if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i.test(text)) {
      throw new Error('不能发指向内网地址的链接')
    }
    return ''
  }

  const abs = path.resolve(env.projectRoot, text)
  const rel = path.relative(env.projectRoot, abs).split(path.sep).join('/')

  if (rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error('只能发项目目录里的文件')
  }

  const blocked = sensitiveReason(rel)
  if (blocked) throw new Error(`这个路径不能发（${rel}）：${blocked}`)

  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`)

  return rel
}

/**
 * 来源检查：本地路径按黑名单同步判；远程地址还要过一遍 DNS 校验。
 * 只检查字面地址挡不住「域名解析到 127.0.0.1」这种绕法。
 */
async function checkSource(source) {
  const rel = assertSendable(source)
  const text = String(source ?? '').trim()
  if (/^https?:\/\//i.test(text)) await assertPublicUrlResolved(text)
  return rel
}

function captionOf(caption) {
  const text = String(caption ?? '').trim()
  return text ? [segment.text(text)] : []
}

/** 音频来源 → 本地文件路径。URL 会先落到 downloads/ */
async function localAudioOf(source) {
  const text = String(source ?? '').trim()
  const downloads = path.join(env.projectRoot, 'downloads')

  if (/^https?:\/\//i.test(text)) {
    fs.mkdirSync(downloads, { recursive: true })
    const response = await fetch(text, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)

    let ext = ''
    try {
      ext = path.extname(new URL(text).pathname).toLowerCase()
    } catch {
      ext = ''
    }
    if (!AUDIO_EXTS.has(ext)) ext = '.m4a'

    const file = path.join(downloads, `audio-${Date.now()}${ext}`)
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    return { file, temporary: true }
  }

  return { file: path.resolve(env.projectRoot, text), temporary: false }
}

/**
 * 转成 mp3 再发。微信里 mp3 文件的兼容性最好；
 * 没有 ffmpeg 或转换失败就按原格式发，别因为转码把整件事卡住。
 */
async function toMp3(file) {
  if (path.extname(file).toLowerCase() === '.mp3') return { file, converted: false }

  const out = path.join(
    path.dirname(file),
    `${path.basename(file, path.extname(file))}-${Date.now()}.mp3`,
  )

  await run(FFMPEG, ['-y', '-i', file, '-codec:a', 'libmp3lame', '-q:a', '5', out], {
    timeout: 120_000,
  })

  if (!fs.existsSync(out)) throw new Error('ffmpeg 没有产出文件')
  return { file: out, converted: true }
}

export const MEDIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_image',
      description:
        '给对方发一张图片。source 可以是本地路径（如 downloads/xxx.png）或 http 图片地址。' +
        '对方发来的图片在 downloads/incoming/ 下，路径就在提示词里，原样传进来即可。' +
        '生成或下载的图先存到 downloads/ 再发。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '本地路径或 http(s) 图片地址' },
          caption: { type: 'string', description: '可选，跟在图片后面的说明文字' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description:
        '给对方发一个文件（PDF、Word、Excel、压缩包、代码等都可以）。' +
        'source 是本地路径或 http(s) 地址，name 是不填就按原文件名显示。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '本地路径或 http(s) 地址' },
          name: { type: 'string', description: '可选，对方看到的名字，如 报告.pdf' },
          caption: { type: 'string', description: '可选，跟在文件后面的说明文字' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_video',
      description: '给对方发一段视频。source 是本地 mp4 路径或 http(s) 地址。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '本地路径或 http(s) 地址' },
          caption: { type: 'string', description: '可选，跟在视频后面的说明文字' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_audio',
      description:
        '给对方发音频。微信没有语音消息，音频会作为文件发出去，并自动转成 mp3（对方点开就能播）。' +
        'source 可以是本地路径或 http(s) 直链——find_music 搜到的试听直链可以直接传进来，不用先下载。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '本地音频路径或 http(s) 直链' },
          caption: { type: 'string', description: '可选，跟在文件后面的说明文字，一般写歌名和歌手' },
        },
        required: ['source'],
      },
    },
  },
]

/**
 * @param {(payload: object) => Promise<void>} send 由调用方提供的发送函数，
 *   内部已经绑定好当前会话的 context_token
 */
export function makeMediaHandlers(send) {
  return {
    send_image: async ({ source, caption } = {}) => {
      const rel = await checkSource(source)
      await send([segment.image(source), ...captionOf(caption)])
      return `图片已发出${rel ? `（${rel}）` : ''}`
    },

    send_file: async ({ source, name, caption } = {}) => {
      const rel = await checkSource(source)
      const fileName = String(name ?? '').trim() || path.basename(rel || String(source))
      await send([segment.file(source, { name: fileName }), ...captionOf(caption)])
      return `文件已发出（${fileName}）`
    },

    send_video: async ({ source, caption } = {}) => {
      const rel = await checkSource(source)
      await send([segment.video(source), ...captionOf(caption)])
      return `视频已发出${rel ? `（${rel}）` : ''}`
    },

    send_audio: async ({ source, caption } = {}) => {
      await checkSource(source)

      const { file: local, temporary } = await localAudioOf(source)
      let file = local
      let note = ''

      try {
        const result = await toMp3(local)
        file = result.file
        if (result.converted) {
          note = '，已转成 mp3'
          // 从 URL 现拉的中间文件转完就删，不然每点一次歌就在 downloads/ 留一份 m4a
          if (temporary) fs.rmSync(local, { force: true })
        }
      } catch (error) {
        // 转码失败不该让「发歌」整件事失败：原格式照样发，说明一下就行
        note = `，转 mp3 失败按原格式发（${String(error?.message ?? error).slice(0, 60)}）`
      }

      const fileName = path.basename(file)
      const full = path.relative(env.projectRoot, file).split(path.sep).join('/')
      await send([segment.file(full, { name: fileName }), ...captionOf(caption)])
      return `音频已发出（${fileName}${note}）`
    },
  }
}
