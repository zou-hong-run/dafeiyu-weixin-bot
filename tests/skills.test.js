import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../src/config/paths.js'
import {
  libraryCount,
  readSkill,
  resetLibraryCache,
  searchLibrary,
  writeSkill,
  listSkills,
} from '../src/skills/store.js'
import { makeSkillHandlers } from '../src/chat/skill-tools.js'

const ROOT = paths.skills
const KEY = 'test:user:skills'

/** 造一个技能库：skills/<目录>/SKILL.md + 一份总索引 */
function makeLibrary() {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'docx'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'docx', 'SKILL.md'), '# docx\n\n读取 Word 文档并提取正文。')

  fs.mkdirSync(path.join(ROOT, 'excel-tools'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'excel-tools', 'SKILL.md'), '# excel-tools\n\n表格处理与公式生成。')

  // 没有 SKILL.md 的目录不算技能库成员
  fs.mkdirSync(path.join(ROOT, 'not-a-skill'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'not-a-skill', 'readme.txt'), 'no skill here')

  fs.writeFileSync(
    path.join(ROOT, 'SKILLS-INDEX.md'),
    '# 技能库总目录\n\n- docx：读 Word\n- excel-tools：表格\n',
  )

  resetLibraryCache()
}

test('技能库扫描：只认带 SKILL.md 的目录', () => {
  makeLibrary()
  assert.equal(libraryCount(), 2, 'not-a-skill 没有 SKILL.md，不该算进来')
})

test('searchLibrary 按目录名模糊匹配', () => {
  makeLibrary()
  assert.deepEqual(searchLibrary('docx'), ['docx'])
  assert.deepEqual(searchLibrary('EXCEL'), ['excel-tools'], '应该忽略大小写')
  assert.deepEqual(searchLibrary(''), ['docx', 'excel-tools'], '空关键词返回全部')
  assert.deepEqual(searchLibrary('不存在的东西'), [])
})

test('readSkill 优先读本会话技能，其次技能库', () => {
  makeLibrary()

  const fromLibrary = readSkill(KEY, 'docx')
  assert.ok(fromLibrary)
  assert.equal(fromLibrary.from, 'library')
  assert.match(fromLibrary.body, /读取 Word 文档/)

  // 本会话写了同名技能，应该盖过技能库
  writeSkill(KEY, 'docx', '适用场景：测试覆盖\n\n这是本会话的版本')
  const fromSession = readSkill(KEY, 'docx')
  assert.equal(fromSession.from, 'session')
  assert.match(fromSession.body, /本会话的版本/)

  fs.rmSync(path.join(ROOT, sanitize(KEY)), { recursive: true, force: true })
})

test('readSkill 能读总索引', () => {
  makeLibrary()
  const index = readSkill(KEY, 'SKILLS-INDEX.md')
  assert.ok(index)
  assert.equal(index.from, 'index')
  assert.match(index.body, /技能库总目录/)
})

test('路径穿越被挡住', () => {
  makeLibrary()
  const cases = [
    '../etc/passwd',
    '..',
    'docx/../../etc/passwd',
    'docx/../excel-tools',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
  ]
  for (const name of cases) {
    const hit = readSkill(KEY, name)
    assert.equal(hit, null, `${name} 不该被读到`)
  }
})

test('超长正文会截断并说明', () => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(ROOT, 'huge'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'huge', 'SKILL.md'), 'x'.repeat(20000))
  resetLibraryCache()

  const hit = readSkill(KEY, 'huge')
  assert.ok(hit)
  assert.ok(hit.body.length < 13000, `应该被截到 12000 附近，实际 ${hit.body.length}`)
  assert.match(hit.body, /只给了前 12000 字/)
})

test('list_skills 带 query 能搜到技能库', () => {
  makeLibrary()
  const handlers = makeSkillHandlers(KEY)

  const all = handlers.list_skills({})
  assert.match(all, /本地技能库共 2 个/)
  assert.match(all, /docx/)

  const matched = handlers.list_skills({ query: 'excel' })
  assert.match(matched, /匹配「excel」的有 1 个/)
  assert.match(matched, /excel-tools/)

  const empty = handlers.list_skills({ query: 'zzz' })
  assert.match(empty, /没有匹配「zzz」/)

  assert.equal(listSkills(KEY).length, 0, '本会话没写过技能')
})

function sanitize(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}
