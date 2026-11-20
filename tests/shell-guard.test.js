import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectCommand, normalizeForMatch } from '../src/mcp-server/shell-guard.js'

test('删根目录和用户主目录被拦', () => {
  assert.equal(inspectCommand('rm -rf /').ok, false)
  assert.equal(inspectCommand('rm -rf ~').ok, false)
  assert.equal(inspectCommand('rm -rf / --no-preserve-root').ok, false)
})

test('读密钥文件被拦', () => {
  assert.equal(inspectCommand('cat .env').ok, false)
  assert.equal(inspectCommand('cat .env.local').ok, false)
  assert.equal(inspectCommand('grep KEY .env').ok, false)
})

test('读记忆和登录凭证被拦', () => {
  assert.equal(inspectCommand('cat data/memory.json').ok, false)
  assert.equal(inspectCommand('cat data/ilink/credentials.json').ok, false)
  assert.equal(inspectCommand('head data/tickets.json').ok, false)
})

test('Windows 反斜杠写法也要拦住', () => {
  // 归一化会把反斜杠删掉，所以靠 data/ 前缀挡不住，得有按文件名的规则兜底
  assert.equal(inspectCommand('type data\\memory.json').ok, false)
  assert.equal(inspectCommand('type data\\ilink\\credentials.json').ok, false)
})

test('读 SSH 密钥和系统账号文件被拦', () => {
  assert.equal(inspectCommand('cat ~/.ssh/id_rsa').ok, false)
  assert.equal(inspectCommand('cat /etc/passwd').ok, false)
  assert.equal(inspectCommand('cat /etc/shadow').ok, false)
})

test('关机、磁盘操作、fork 炸弹被拦', () => {
  assert.equal(inspectCommand('shutdown -h now').ok, false)
  assert.equal(inspectCommand('mkfs.ext4 /dev/sda1').ok, false)
  assert.equal(inspectCommand('dd if=/dev/zero of=/dev/sda').ok, false)
  assert.equal(inspectCommand(':(){ :|:& };:').ok, false)
})

test('导出环境变量被拦（会泄露密钥）', () => {
  assert.equal(inspectCommand('env').ok, false)
  assert.equal(inspectCommand('printenv').ok, false)
  assert.equal(inspectCommand('env | grep KEY').ok, false)
})

test('全角字符和零宽字符绕不过去', () => {
  assert.equal(inspectCommand('ｒｍ -rf /').ok, false)
  assert.equal(inspectCommand('rm\u200b -rf /').ok, false)
})

test('引号拆词绕不过去', () => {
  assert.equal(inspectCommand("r''m -rf /").ok, false)
  assert.equal(inspectCommand('r\\m -rf /').ok, false)
})

test('正常命令放行', () => {
  for (const cmd of [
    'node src/index.js',
    'ls data',
    'cat src/index.js',
    'grep -rn foo src/',
    'pnpm install --prod',
    'git status',
  ]) {
    assert.equal(inspectCommand(cmd).ok, true, cmd)
  }
})

test('空命令被拒', () => {
  assert.equal(inspectCommand('').ok, false)
  assert.equal(inspectCommand('   ').ok, false)
})

test('normalizeForMatch 把全角和引号统一掉', () => {
  assert.equal(normalizeForMatch('ｒｍ  -rf'), 'rm -rf')
  assert.equal(normalizeForMatch("r''m -rf"), 'rm -rf')
})
