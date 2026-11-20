#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { prepareTestEnv } from './prepare-env.js'

// 本地检查。`pnpm check` 和 CI 跑的是同一份。
//
// 四道：
//   1. 语法      —— node --check，抓括号和字符串截断这类低级错误
//   2. 模块加载  —— import 一遍，抓漏 import、循环依赖、顶层副作用炸掉
//   3. 安全一致性 —— 权限表自洽（危险工具都有条目、白名单不冲突）
//   4. 单元测试  —— 纯逻辑部分
//
// 加 --quiet 只输出失败项，给自动同步用。

const projectRoot = prepareTestEnv()
const QUIET = process.argv.includes('--quiet')
const failures = []

function rel(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/')
}

function log(...args) {
  if (!QUIET) console.log(...args)
}

function fail(label, detail) {
  failures.push({ label, detail: String(detail ?? '').trim().slice(0, 600) })
}

function pass(label) {
  log(`  ✓ ${label}`)
}

function walk(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(full, out)
    } else if (entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(path.join(projectRoot, 'src')), ...walk(path.join(projectRoot, 'scripts'))]

// ── 1. 语法 ──
let syntaxOk = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 20_000 })
  if (result.status === 0) {
    syntaxOk += 1
    continue
  }
  fail(`语法：${rel(file)}`, result.stderr)
}
pass(`${syntaxOk}/${files.length} 个文件语法通过`)

// ── 2. 模块加载 ──
// index.js 会真的启动机器人，跳过；其余都试着 import 一遍
// 这几类只做语法检查，不做加载检查：
//   · src/index.js         —— import 就启动机器人
//   · src/mcp-server/index.js —— MCP 服务入口，import 就开始等 stdio，会挂住
//   · scripts/ 下的脚本    —— import 就执行（有的直接 process.exit）
const SKIP_LOAD = new Set(['src/index.js', 'src/mcp-server/index.js'])
const SKIP_LOAD_PREFIX = ['scripts/']

const moduleTargets = files.filter((file) => {
  const name = rel(file)
  if (SKIP_LOAD.has(name)) return false
  return !SKIP_LOAD_PREFIX.some((prefix) => name.startsWith(prefix))
})
let loadOk = 0

for (const file of moduleTargets) {
  const code = `await import(${JSON.stringify(pathToFileURL(file).href)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 40_000,
    env: process.env,
  })
  if (result.status === 0) {
    loadOk += 1
    continue
  }
  fail(`加载：${rel(file)}`, result.stderr || result.stdout)
}
pass(`${loadOk}/${moduleTargets.length} 个模块加载成功`)

// ── 3. 安全一致性 ──
// 权限表最容易出的问题是「加了个危险工具但忘了登记」，或者白名单和危险名单打架。
// 这类错误静态检查能抓住，不用等真被越权。
try {
  const policyUrl = pathToFileURL(path.join(projectRoot, 'src', 'config', 'policy.js')).href
  const policy = await import(policyUrl)

  const dangerous = [...policy.DANGEROUS_TOOLS]
  const table = policy.TOOL_POLICY ?? {}

  const missing = dangerous.filter((name) => !table[name])
  if (missing.length > 0) fail('权限表缺口', `这些高危工具没有 TOOL_POLICY 条目：${missing.join('、')}`)

  // SAFE_TOOLS 是内部集合，通过 isDangerousTool 反推：明确声明安全的不能被判危险
  const safeProbe = ['todo_write', 'exit_plan_mode', 'write_skill', 'delete_skill']
  const wrong = safeProbe.filter((name) => policy.isDangerousTool(name))
  if (wrong.length > 0) fail('白名单失效', `这些工具声明安全但仍被判高危：${wrong.join('、')}`)

  // 反过来：明显危险的必须被判高危
  const mustBeDangerous = ['shell', 'write_file', 'add_mcp', 'install_package']
  const leaked = mustBeDangerous.filter((name) => !policy.isDangerousTool(name))
  if (leaked.length > 0) fail('高危漏判', `这些工具该判高危却没判：${leaked.join('、')}`)

  if (failures.every((item) => !item.label.startsWith('权限') && !item.label.startsWith('白名单') && !item.label.startsWith('高危'))) {
    pass('权限表自洽')
  }
} catch (error) {
  fail('安全一致性检查', error?.message ?? error)
}

// ── 4. 单元测试 ──
const testsDir = path.join(projectRoot, 'tests')
if (fs.existsSync(testsDir)) {
  // 清掉授权相关的环境变量：测试要验证「默认拒绝」，
  // 本机配了 ADMIN_USER_IDS 的话那条断言会假失败
  const testEnv = { ...process.env, ADMIN_USER_IDS: '', ALLOW_DANGEROUS: 'false' }

  const testFiles = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join('tests', name))

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: testEnv,
  })
  if (result.status === 0) {
    const summary = (result.stdout ?? '')
      .split('\n')
      .find((line) => /^# (pass|tests)/.test(line.trim()))
    pass(`单元测试通过${summary ? `（${summary.replace(/^#\s*/, '')}）` : ''}`)
  } else {
    fail('单元测试', `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
} else {
  log('  - 没有 tests/ 目录，跳过单元测试')
}

// ── 结果 ──
if (failures.length === 0) {
  log('\n全部通过。')
  process.exit(0)
}

console.error(`\n${failures.length} 项没通过：\n`)
for (const item of failures) {
  console.error(`✗ ${item.label}`)
  if (item.detail) console.error(item.detail.split('\n').slice(0, 12).map((line) => `  ${line}`).join('\n'))
  console.error('')
}
process.exit(1)
