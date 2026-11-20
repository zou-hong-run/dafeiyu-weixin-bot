import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dataPath } from '../src/config/paths.js'
import { canPushTo, flushActivity, idleMinutesOf, lastActiveAt, touchActivity } from '../src/ops/activity.js'

test('记一笔活跃后能读回来', () => {
  touchActivity('k1', 1700000000000)
  assert.equal(lastActiveAt('k1'), 1700000000000)
})

test('从没活跃过的会话，闲置时间是无穷大，不能主动推', () => {
  assert.equal(idleMinutesOf('never-seen'), Infinity)
  assert.equal(canPushTo('never-seen'), false)
})

test('刚活跃过的会话可以推', () => {
  touchActivity('k2')
  assert.ok(canPushTo('k2'))
  assert.ok(idleMinutesOf('k2') < 1)
})

// 这条是回归：之前 flush 里引用了已删除的 dataDir 变量，
// 落盘静默失败，活跃度永远不更新——推送门控等于瞎了。
test('落盘真的写出文件，不吞异常', () => {
  touchActivity('k3', 1700000000001)
  flushActivity()

  assert.ok(fs.existsSync(dataPath.activity), 'activity.json 应该被写出来')

  const saved = JSON.parse(fs.readFileSync(dataPath.activity, 'utf8'))
  assert.equal(saved.k3, 1700000000001)
})
