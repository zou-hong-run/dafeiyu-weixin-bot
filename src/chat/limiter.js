// 并发控制。
//
// 多用户同时聊天时，每个会话都会打模型、调工具。不加限制的话：
//   · 十个用户同时说话 = 十个并发请求打到 DeepSeek，容易撞限流（429）
//   · 十个 shell 工具同时跑 = 十个子进程，内存直接吃满
//   · 撞了限流后所有请求一起重试，雪崩
//
// 这里给两类资源各加一个闸门：模型调用、工具调用。超出的排队，不是拒绝。

/**
 * @param {string} name 给日志和 /diag 看的名字
 * @param {number} max 同时最多几个
 */
export function createLimiter(name, max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1))

  let active = 0
  let peak = 0
  let served = 0
  let waitedTotal = 0
  const queue = []

  /**
   * @param {() => Promise<any>} task
   * @param {{ onWait?: (ms: number) => void }} [options]
   */
  async function run(task, options = {}) {
    if (active >= limit) {
      const enqueuedAt = Date.now()
      await new Promise((resolve) => queue.push(resolve))
      const waited = Date.now() - enqueuedAt
      waitedTotal += waited
      options.onWait?.(waited)
    }

    active += 1
    peak = Math.max(peak, active)

    try {
      return await task()
    } finally {
      active -= 1
      served += 1
      // 唤醒一个等着的。不用循环唤醒，被唤醒的那个会自己继续往下走
      const next = queue.shift()
      if (next) next()
    }
  }

  function stats() {
    return {
      name,
      limit,
      active,
      queued: queue.length,
      peak,
      served,
      avgWaitMs: served > 0 ? Math.round(waitedTotal / served) : 0,
    }
  }

  return { run, stats }
}
