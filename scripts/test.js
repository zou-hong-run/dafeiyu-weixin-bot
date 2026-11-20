#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 跑单元测试。
//
// 为什么不用 `node --test tests/` 或 `node --test "tests/*.test.js"`：
//   · 目录参数会被当成模块路径去 resolve（Windows 上报 Cannot find module）
//   · glob 要靠 Node 自己展开，不同小版本行为不一样，CI 和本地容易跑出两种结果
// 显式列出文件最稳，跨平台一致。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(projectRoot, 'tests')

// 测试进程会 import 业务模块，其中 env.js 缺 key 会直接 process.exit(1)。
// 本地有 .env 所以看不出来，CI 上没有——这里补个占位值。
if (!process.env.DEEP_SEEK_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  process.env.DEEP_SEEK_API_KEY = 'test-placeholder'
}
// 授权相关的变量清空：policy 测试要验证「未配白名单时默认拒绝」
process.env.ADMIN_USER_IDS = ''
process.env.ALLOW_DANGEROUS = 'false'
// 落盘都往 tmp 里写，别碰真实数据
process.env.TMP_DIR ||= path.join(projectRoot, 'tmp', 'test')

let files = []
try {
  files = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', name))
} catch {
  console.error('没有 tests/ 目录')
  process.exit(1)
}

if (files.length === 0) {
  console.error('tests/ 里没有 *.test.js')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: projectRoot,
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
