import test from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from '../src/chat/limiter.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('并发不超过上限', async () => {
  const limiter = createLimiter('test', 2)
  let active = 0
  let peak = 0

  await Promise.all(
    Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(20)
        active -= 1
      }),
    ),
  )

  assert.ok(peak <= 2, `峰值 ${peak} 超过了上限 2`)
  assert.equal(limiter.stats().peak, 2)
  assert.equal(limiter.stats().served, 6)
})

test('超出的任务会排队而不是被丢弃', async () => {
  const limiter = createLimiter('test', 1)
  const order = []

  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      limiter.run(async () => {
        order.push(i)
        await sleep(5)
      }),
    ),
  )

  assert.equal(order.length, 4)
  assert.deepEqual(order, [0, 1, 2, 3], '排队应该保持顺序')
})

test('任务抛错也不占着名额', async () => {
  const limiter = createLimiter('test', 1)

  await assert.rejects(limiter.run(async () => {
    throw new Error('boom')
  }))

  // 上一个失败了，下一个还得能跑
  const result = await limiter.run(async () => 'ok')
  assert.equal(result, 'ok')
  assert.equal(limiter.stats().active, 0)
})

test('上限至少是 1', async () => {
  const limiter = createLimiter('test', 0)
  assert.equal(limiter.stats().limit, 1)

  const results = await Promise.all([1, 2, 3].map((n) => limiter.run(async () => n)))
  assert.deepEqual(results, [1, 2, 3])
})

test('stats 能反映排队情况', async () => {
  const limiter = createLimiter('test', 1)
  const running = limiter.run(async () => sleep(30))
  await sleep(5)

  // 第二个会排队
  const queued = limiter.run(async () => sleep(5))
  await sleep(5)
  assert.ok(limiter.stats().queued >= 1)

  await Promise.all([running, queued])
  assert.equal(limiter.stats().queued, 0)
})
