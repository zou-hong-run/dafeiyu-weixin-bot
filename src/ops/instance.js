import fs from 'node:fs'
import path from 'node:path'

// 单实例锁。
//
// 为什么必须有：同一个 ClawBot 账号只能有一个实例在长轮询。
// 两个进程同时 getupdates 会互相覆盖游标——消息可能被其中一个吞掉，
// 表现是「有时候不回、有时候回两遍」，而且两边的日志看着都正常。
//
// 锁文件里写 pid。进程没了但锁还在（kill -9、断电），下次启动会识别成陈旧锁并接管。

/** 这个 pid 还活着吗 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // 信号 0 不做任何事，只探测进程是否存在
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但没权限发信号（别人的进程），仍算活着
    return error?.code === 'EPERM'
  }
}

/**
 * 拿锁。拿不到就抛错，让调用方退出。
 * @param {string} file 锁文件路径
 * @returns {() => void} 释放函数
 */
export function acquireInstanceLock(file) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // wx = 只在文件不存在时创建。这是原子的，两个进程同时抢只有一个能成
      const fd = fs.openSync(target, 'wx', 0o600)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)

      // 进程退出时删锁；异常退出靠下次启动识别陈旧锁
      const release = () => {
        try {
          const current = String(fs.readFileSync(target, 'utf8')).trim()
          if (current === String(process.pid)) fs.rmSync(target, { force: true })
        } catch {
          // 文件已经没了，正常
        }
      }

      process.on('exit', release)
      return release
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error

      let holder = 0
      try {
        holder = Number(String(fs.readFileSync(target, 'utf8')).trim())
      } catch {
        holder = 0
      }

      if (alive(holder)) {
        throw new Error(
          `已经有一个实例在跑（pid ${holder}，锁文件 ${target}）。\n` +
            '同一个微信号只能有一个实例轮询，两个一起跑会互相吞消息。\n' +
            '要换新进程，先停掉旧的；确认它已经死了但锁还在，删掉锁文件重试。',
        )
      }

      // 陈旧锁：上次没干净退出，接管它
      fs.rmSync(target, { force: true })
    }
  }

  throw new Error(`拿不到实例锁：${target}。删掉这个文件再启动。`)
}
