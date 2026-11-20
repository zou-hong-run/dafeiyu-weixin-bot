import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveReason } from '../src/ops/file-policy.js'

test('密钥和配置被拒', () => {
  assert.ok(sensitiveReason('.env'))
  assert.ok(sensitiveReason('.env.local'))
  assert.ok(sensitiveReason('.env.production'))
})

test('数据目录被拒', () => {
  assert.ok(sensitiveReason('data'))
  assert.ok(sensitiveReason('data/memory.json'))
  assert.ok(sensitiveReason('data/ilink/credentials.json'))
})

test('其它敏感目录被拒', () => {
  for (const p of ['backups/x.json', 'logs/bot.log', 'node_modules/foo/index.js', '.git/config', '.ssh/id_rsa', 'tmp/a.txt']) {
    assert.ok(sensitiveReason(p), p)
  }
})

test('路径穿越被拒', () => {
  assert.ok(sensitiveReason('../etc/passwd'))
  assert.ok(sensitiveReason('..'))
})

test('反斜杠和前缀写法绕不过去', () => {
  assert.ok(sensitiveReason('data\\memory.json'))
  assert.ok(sensitiveReason('./data/memory.json'))
  assert.ok(sensitiveReason('data/../backups/x.json'))
  assert.ok(sensitiveReason('foo/../data/memory.json'))
})

test('正常路径放行', () => {
  for (const p of ['src/index.js', 'docs/README.md', 'README.md', 'skills/x.md']) {
    assert.equal(sensitiveReason(p), '', p)
  }
})
