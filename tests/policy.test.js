import test from 'node:test'
import assert from 'node:assert/strict'
import { DANGEROUS_TOOLS, TOOL_POLICY, isDangerousTool, isToolAllowed, denyReason } from '../src/config/policy.js'

test('明确声明安全的工具不被名字误判', () => {
  // todo_write 里的 write、delete_skill 里的 delete 都会命中能力词，
  // 但它们是 SAFE_TOOLS，不该要求管理员
  for (const name of ['todo_write', 'exit_plan_mode', 'write_skill', 'delete_skill']) {
    assert.equal(isDangerousTool(name), false, name)
  }
})

test('真正危险的工具必须判高危', () => {
  for (const name of ['shell', 'run_script', 'write_file', 'edit_file', 'add_mcp', 'install_package', 'git_sync']) {
    assert.equal(isDangerousTool(name), true, name)
  }
})

test('每个高危工具都有权限表条目', () => {
  // 加了危险工具却忘了登记，这条会红
  for (const name of DANGEROUS_TOOLS) {
    assert.ok(TOOL_POLICY[name], `${name} 没有 TOOL_POLICY 条目`)
  }
})

test('能力词兜底：未知工具按名字判断', () => {
  // 以后 add_mcp 注册进来的新工具，名字带这些词也要走白名单
  assert.equal(isDangerousTool('filesystem.write_file'), true)
  assert.equal(isDangerousTool('execCommand'), true)
  assert.equal(isDangerousTool('db.remove_all'), true)
  assert.equal(isDangerousTool('weather'), false)
})

test('未配白名单时默认拒绝高危、放行只读', () => {
  // check.js 跑测试时会清掉 ADMIN_USER_IDS 和 ALLOW_DANGEROUS
  assert.equal(isToolAllowed('shell', 'stranger'), false)
  assert.equal(isToolAllowed('write_file', 'stranger'), false)
  assert.equal(isToolAllowed('search', 'stranger'), true)
  assert.equal(isToolAllowed('read_file', 'stranger'), true)
  assert.equal(isToolAllowed('todo_write', 'stranger'), true)
})

test('未知工具默认拒绝', () => {
  assert.equal(isToolAllowed('some_random_tool', 'stranger'), false)
})

test('拒绝时给出可操作的原因', () => {
  const reason = denyReason('shell', 'stranger')
  assert.match(reason, /shell/)
  assert.match(reason, /ADMIN_USER_IDS|ALLOW_DANGEROUS/)
})
