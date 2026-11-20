import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { truncateToolResult, cleanupSpill } from '../src/chat/truncate.js'
import { paths } from '../src/config/paths.js'

function makeLines(count, width = 40) {
  return Array.from({ length: count }, (_, i) => `line${i + 1}: ${'x'.repeat(width)}`).join('\n')
}

test('短文本原样返回', () => {
  assert.equal(truncateToolResult('hello'), 'hello')
  assert.equal(truncateToolResult(''), '')
})

test('超长文本保留开头和结尾，中间省略', () => {
  const long = makeLines(200)
  const out = truncateToolResult(long, { toolName: 'shell', callId: 'c1' })

  assert.ok(out.length < long.length, '应该被截短')
  assert.ok(out.includes('[开头]'))
  assert.ok(out.includes('[结尾]'))
  assert.ok(out.includes('[中间省略'), '要标出省略了多少')
})

test('结尾一定要留下——报错和结果常在最后几行', () => {
  const long = `${makeLines(200)}\nFATAL: disk quota exceeded`
  const out = truncateToolResult(long, { toolName: 'shell', callId: 'c2' })
  assert.ok(out.includes('FATAL: disk quota exceeded'), '最后一行的报错不能丢')
})

test('单行超长会被截断，不会整行塞进去', () => {
  const oneLine = 'y'.repeat(9000)
  const out = truncateToolResult(oneLine, { toolName: 'fetch', callId: 'c3' })

  assert.ok(out.includes('本行已截断'))
  assert.ok(out.length < 4000, `单行超长应该被压下来，实际 ${out.length}`)
})

test('超限时把完整内容落盘，并给出可读路径', () => {
  const long = makeLines(200)
  const out = truncateToolResult(long, { toolName: 'shell', callId: 'spill-test' })

  assert.ok(/\.txt/.test(out), '提示里应该带落盘文件路径')
  assert.ok(/read_file/.test(out), '要告诉模型怎么读回来')

  const spillDir = path.join(paths.tmp, 'tool-output')
  const files = fs.existsSync(spillDir) ? fs.readdirSync(spillDir) : []
  assert.ok(files.some((f) => f.startsWith('shell-spill-test')), '落盘文件应该存在')

  // 落盘的是完整原文
  const target = files.find((f) => f.startsWith('shell-spill-test'))
  const saved = fs.readFileSync(path.join(spillDir, target), 'utf8')
  assert.equal(saved, long)
})

test('清理会删掉过期文件', () => {
  const out = truncateToolResult(makeLines(200), { toolName: 'shell', callId: 'cleanup-test' })
  assert.ok(out)

  // ttl 传 0 表示不清理（函数里的保护），传很小的正数并改 mtime 才能测到
  const spillDir = path.join(paths.tmp, 'tool-output')
  const target = fs.readdirSync(spillDir).find((f) => f.startsWith('shell-cleanup-test'))
  if (target) {
    const full = path.join(spillDir, target)
    const old = Date.now() - 48 * 3600 * 1000
    fs.utimesSync(full, new Date(old), new Date(old))
    const removed = cleanupSpill(24)
    assert.ok(removed >= 1)
    assert.ok(!fs.existsSync(full))
  }
})
