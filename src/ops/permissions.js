import fs from 'node:fs'
import path from 'node:path'
import { isWindows } from './platform.js'

// 收紧敏感文件的权限。
//
// Windows 上 chmod 基本不生效（权限走 ACL），所以直接跳过。
// Linux 上必须做——默认 umask 022 建出来的文件是 644，同机任何用户都能读，
// 而 data/ilink/credentials.json 里是能收发这个微信号消息的 bot_token。

const DIRS = [
  ['data', 0o700],
  ['data/ilink', 0o700],
  ['logs', 0o700],
  ['tmp', 0o700],
]

const FILES = [
  ['.env', 0o600],
  ['data/ilink/credentials.json', 0o600],
  ['data/ilink/context_tokens.json', 0o600],
  ['data/memory.json', 0o600],
  ['data/tickets.json', 0o600],
  ['data/schedules.json', 0o600],
]

/**
 * @returns {string[]} 实际改动过的项，启动日志会打出来
 */
export function tightenPermissions(projectRoot) {
  if (isWindows) return []

  const changed = []

  for (const [rel, mode] of [...DIRS, ...FILES]) {
    const target = path.join(projectRoot, rel)
    try {
      if (!fs.existsSync(target)) continue
      const before = fs.statSync(target).mode & 0o777
      if (before === mode) continue
      fs.chmodSync(target, mode)
      changed.push(`${rel} ${before.toString(8)} → ${mode.toString(8)}`)
    } catch (error) {
      // 权限改不动不该拦住启动，但要说出来
      console.warn(`[权限] 收紧 ${rel} 失败：`, error?.message ?? error)
    }
  }

  return changed
}
