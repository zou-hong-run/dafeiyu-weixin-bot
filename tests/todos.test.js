import test from 'node:test'
import assert from 'node:assert/strict'
import { setTodos, getTodos, clearTodos, todoProgress, staleReminder } from '../src/chat/todos.js'

const KEY = 'test:user:todos'

test('写入和读取', () => {
  clearTodos(KEY)
  const list = setTodos(KEY, [
    { title: '第一步', status: 'done' },
    { title: '第二步', status: 'in_progress' },
    { title: '第三步', status: 'pending' },
  ])

  assert.equal(list.length, 3)
  assert.equal(getTodos(KEY).length, 3)
  assert.deepEqual(todoProgress(list), {
    total: 3,
    done: 1,
    open: 2,
    inProgress: [{ title: '第二步', status: 'in_progress' }],
  })
  clearTodos(KEY)
})

test('只允许一项进行中，多余的降级为待办', () => {
  clearTodos(KEY)
  const list = setTodos(KEY, [
    { title: 'A', status: 'in_progress' },
    { title: 'B', status: 'in_progress' },
    { title: 'C', status: 'in_progress' },
  ])

  const active = list.filter((item) => item.status === 'in_progress')
  assert.equal(active.length, 1, '同时只能有一项在跑，否则清单说不清进度')
  assert.equal(active[0].title, 'A', '保留第一项')
  assert.equal(list[1].status, 'pending')
  clearTodos(KEY)
})

test('非法状态和空标题会被丢掉', () => {
  clearTodos(KEY)
  const list = setTodos(KEY, [
    { title: '', status: 'done' },
    { title: '正常', status: 'whatever' },
    { title: '也有', status: 'done' },
  ])

  assert.equal(list.length, 2)
  assert.equal(list[0].status, 'pending', '非法状态退回 pending')
  clearTodos(KEY)
})

test('传空数组等于清空', () => {
  clearTodos(KEY)
  setTodos(KEY, [{ title: 'x', status: 'pending' }])
  setTodos(KEY, [])
  assert.equal(getTodos(KEY).length, 0)
})

test('过期提醒：不到阈值不催，到了才催', () => {
  clearTodos(KEY)
  const list = setTodos(KEY, [
    { title: 'done 的', status: 'done' },
    { title: '没做完的', status: 'in_progress' },
  ])

  assert.equal(staleReminder(list, 3), '', '没到 5 轮不催')
  const reminder = staleReminder(list, 6)
  assert.ok(reminder.includes('6 轮没更新'))
  assert.ok(reminder.includes('没做完的'))
  clearTodos(KEY)
})

test('全做完了就不催', () => {
  clearTodos(KEY)
  const list = setTodos(KEY, [{ title: 'only', status: 'done' }])
  assert.equal(staleReminder(list, 10), '')
  clearTodos(KEY)
})

test('空清单不催', () => {
  assert.equal(staleReminder([], 10), '')
})
