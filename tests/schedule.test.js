import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../src/config/paths.js'
import {
  addSchedule,
  cronMatches,
  listSchedules,
  nextMatchOf,
  removeSchedule,
  useSchedulesDir,
} from '../src/tasks/scheduler.js'
import { makeScheduleHandlers } from '../src/chat/schedule-tools.js'

// 每条用例前把任务文件指到 tmp 里，绝不碰真实 data/schedules.json
const dir = path.join(paths.tmp, 'test', 'schedules')

function fresh() {
  fs.rmSync(dir, { recursive: true, force: true })
  useSchedulesDir(dir)
}

const TARGET = { type: 'user', id: 'u1', tenantId: 'wx-t1' }

test('合法 cron 能加上，并算得出下次触发时间', () => {
  fresh()
  const task = addSchedule({
    sessionKey: 'wx-t1:user:u1',
    target: TARGET,
    cron: '30 8 * * *',
    prompt: '每天早上提醒他今天的日程',
    createdBy: 'u1',
  })

  assert.match(task.id, /^sched-/)
  assert.equal(task.when, '每天 08:30')
  assert.ok(nextMatchOf('30 8 * * *'))
  assert.equal(listSchedules('wx-t1:user:u1').length, 1)
})

test('cron 段数不对直接拒绝，并说清要五段', () => {
  fresh()
  assert.throws(
    () => addSchedule({ sessionKey: 'k', target: TARGET, cron: '30 8 * *', prompt: '每天提醒我喝水' }),
    /5 段/,
  )
  assert.equal(listSchedules('k').length, 0)
})

test('cron 里有非法值时被拒，不会悄悄存进去', () => {
  fresh()
  assert.throws(
    () => addSchedule({ sessionKey: 'k', target: TARGET, cron: '0 25 * * *', prompt: '每天提醒我喝水' }),
    /不合法/,
  )
})

test('任务描述太短被拒：写「提醒一下」到点没法执行', () => {
  fresh()
  assert.throws(
    () => addSchedule({ sessionKey: 'k', target: TARGET, cron: '0 9 * * *', prompt: '提醒' }),
    /太短/,
  )
})

test('列表按会话隔离，别人的任务看不到', () => {
  fresh()
  addSchedule({ sessionKey: 'a:user:1', target: TARGET, cron: '0 9 * * *', prompt: '给自己发早安' })
  addSchedule({ sessionKey: 'b:user:2', target: TARGET, cron: '0 9 * * *', prompt: '给自己发早安' })

  assert.equal(listSchedules('a:user:1').length, 1)
  assert.equal(listSchedules('b:user:2').length, 1)
  // 管理员视图才看得到全部
  assert.equal(listSchedules('a:user:1', { all: true }).length, 2)
})

test('删别人的任务被拒，删自己的可以', () => {
  fresh()
  const mine = addSchedule({
    sessionKey: 'a:user:1',
    target: TARGET,
    cron: '0 9 * * *',
    prompt: '给自己发早安',
    createdBy: 'u1',
  })

  assert.throws(() => removeSchedule(mine.id, 'a:user:1', { actor: 'someone-else' }), /别人建的/)
  assert.equal(listSchedules('a:user:1').length, 1)

  removeSchedule(mine.id, 'a:user:1', { actor: 'u1' })
  assert.equal(listSchedules('a:user:1').length, 0)
})

test('管理员能删别人的任务', () => {
  fresh()
  const mine = addSchedule({
    sessionKey: 'a:user:1',
    target: TARGET,
    cron: '0 9 * * *',
    prompt: '给自己发早安',
    createdBy: 'u1',
  })

  removeSchedule(mine.id, 'x:user:9', { actor: 'root', isAdmin: true })
  assert.equal(listSchedules('a:user:1').length, 0)
})

test('每条会话最多 5 个任务', () => {
  fresh()
  for (let i = 0; i < 5; i += 1) {
    addSchedule({ sessionKey: 'k', target: TARGET, cron: `0 ${i + 1} * * *`, prompt: `第 ${i} 个提醒任务` })
  }
  assert.throws(
    () => addSchedule({ sessionKey: 'k', target: TARGET, cron: '0 9 * * *', prompt: '第六个提醒任务' }),
    /上限 5/,
  )
})

test('工具层从会话键反解出推送目标，模型改不了收件人', () => {
  fresh()
  const handlers = makeScheduleHandlers('wx-t1:user:u1', { actor: 'u1' })
  const text = handlers.schedule_task({ cron: '30 8 * * *', prompt: '每天早上提醒他今天的日程' })

  assert.match(text, /已加/)
  const [task] = listSchedules('wx-t1:user:u1', { all: true })
  // 目标写死成发话的人自己：就算模型想推给别人，也没有这个参数
  assert.deepEqual(task.target, { type: 'user', id: 'u1', tenantId: 'wx-t1' })
  assert.equal(task.createdBy, 'u1')
})

test('工具层加完会提醒推送有闲置窗口限制', () => {
  fresh()
  const handlers = makeScheduleHandlers('wx-t1:user:u1', { actor: 'u1' })
  const text = handlers.schedule_task({ cron: '30 8 * * *', prompt: '每天早上提醒他今天的日程' })
  assert.match(text, /分钟内说过话/)
})

test('工具层删任务要验身份', () => {
  fresh()
  const owner = makeScheduleHandlers('wx-t1:user:u1', { actor: 'u1' })
  const text = owner.schedule_task({ cron: '30 8 * * *', prompt: '每天早上提醒他今天的日程' })
  const id = text.match(/sched-[a-z0-9]+/)[0]

  const stranger = makeScheduleHandlers('wx-t1:user:u2', { actor: 'u2' })
  // 抛出去由 tool-runner 兜成文本回给模型，不在这里吞
  assert.throws(() => stranger.remove_schedule({ id }), /找不到|别人建的/)
  assert.match(owner.remove_schedule({ id }), /已删掉/)
})

test('cron 命中判断：只在那一分钟为真', () => {
  const at = new Date(2026, 0, 5, 8, 30, 10)
  assert.equal(cronMatches('30 8 * * *', at), true)
  assert.equal(cronMatches('30 8 * * *', new Date(2026, 0, 5, 8, 31, 10)), false)
  assert.equal(cronMatches('乱写', at), false)
})
