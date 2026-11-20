#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareTestEnv } from './prepare-env.js'

// 跑单元测试。
//
// 为什么不用 `node --test tests/` 或 `node --test "tests/*.test.js"`：
//   · 目录参数会被当成模块路径去 resolve（Windows 上报 Cannot find module）
//   · glob 要靠 Node 自己展开，不同小版本行为不一样，CI 和本地容易跑出两种结果
// 显式列出文件最稳，跨平台一致。

const projectRoot = prepareTestEnv()
const testsDir = path.join(projectRoot, 'tests')

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
