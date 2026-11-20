import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { paths } from '../config/paths.js'
import { log } from './logger.js'

// 代码同步：把自己的改动推上去，再把远端的拉下来合并。
//
// 几条硬规矩，都是为了别把仓库搞坏：
//   · 用 execFile 直接调 git，不经过 shell（避免命令拼接注入）
//   · 永远不 force push
//   · 合并冲突就停，中止合并，报给人处理——自动解冲突是最容易丢代码的地方
//   · detached HEAD 不动（推上去不知道推哪）
//   · 只推当前分支，不推所有分支

const run = promisify(execFile)
const TIMEOUT = 120_000

async function git(args) {
  const { stdout, stderr } = await run('git', args, {
    cwd: paths.projectRoot,
    timeout: TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
    // 不弹编辑器、不要交互
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  })
  return { stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() }
}

async function gitOk(args) {
  try {
    return { ok: true, ...(await git(args)) }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? error?.message ?? error).trim(),
    }
  }
}

/** 当前状态：分支、有没有改动、领先/落后远端多少 */
export async function gitStatus() {
  const inside = await gitOk(['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, reason: '这个目录不是 git 仓库' }
  }

  const branch = await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok) return { ok: false, reason: `读不到分支：${branch.stderr.slice(0, 120)}` }
  if (branch.stdout === 'HEAD') {
    return { ok: false, reason: '当前是 detached HEAD，不知道该推到哪个分支' }
  }

  const changes = await gitOk(['status', '--porcelain'])
  const files = changes.ok ? changes.stdout.split('\n').filter(Boolean) : []

  // 有没有 upstream、领先落后多少
  let ahead = 0
  let behind = 0
  let hasUpstream = false
  const counts = await gitOk(['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  if (counts.ok) {
    hasUpstream = true
    const [b, a] = counts.stdout.split(/\s+/).map((n) => Number(n) || 0)
    behind = b
    ahead = a
  }

  return {
    ok: true,
    branch: branch.stdout,
    files,
    dirty: files.length > 0,
    hasUpstream,
    ahead,
    behind,
  }
}

/** 提交本地改动（没有就不提交） */
async function commitLocal(message) {
  const status = await gitStatus()
  if (!status.ok) throw new Error(status.reason)
  if (!status.dirty) return { committed: false, files: 0 }

  const add = await gitOk(['add', '-A'])
  if (!add.ok) throw new Error(`git add 失败：${add.stderr.slice(0, 200)}`)

  const commit = await gitOk(['commit', '-m', message])
  if (!commit.ok) {
    // 常见于只有权限/换行符变化，git 认为没东西可提交
    if (/nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) {
      return { committed: false, files: 0 }
    }
    throw new Error(`git commit 失败：${commit.stderr.slice(0, 300)}`)
  }

  return { committed: true, files: status.files.length }
}

/** 推到当前分支。没有 upstream 就先设一个 */
async function pushBranch() {
  const status = await gitStatus()
  if (!status.ok) throw new Error(status.reason)

  const args = status.hasUpstream
    ? ['push']
    : ['push', '--set-upstream', 'origin', status.branch]

  const push = await gitOk(args)
  if (!push.ok) throw new Error(`git push 失败：${(push.stderr || push.stdout).slice(0, 300)}`)
  return { branch: status.branch }
}

/**
 * 拉取远端并合并。
 *
 * ff-only 能过就用它（最干净）；过不了说明有分叉，退回普通 merge。
 * 有冲突就中止并把冲突文件报出来——不替人做决定。
 */
async function pullMerge() {
  const fetch = await gitOk(['fetch', '--prune'])
  if (!fetch.ok) throw new Error(`git fetch 失败：${fetch.stderr.slice(0, 200)}`)

  const before = await gitStatus()
  if (!before.ok) throw new Error(before.reason)
  if (!before.hasUpstream) return { merged: false, reason: '当前分支没有 upstream，跳过拉取' }
  if (before.behind === 0) return { merged: false, reason: '已经是最新' }

  // 先试快进
  const ff = await gitOk(['merge', '--ff-only', '@{u}'])
  if (ff.ok) return { merged: true, mode: 'ff', files: 0 }

  // 快进不了：有分叉，走正常合并
  const merge = await gitOk(['merge', '--no-edit', '@{u}'])
  if (merge.ok) return { merged: true, mode: 'merge', files: 0 }

  // 冲突：中止，别留一个半合并的仓库
  const conflicts = await gitOk(['diff', '--name-only', '--diff-filter=U'])
  await gitOk(['merge', '--abort'])

  const list = conflicts.ok ? conflicts.stdout.split('\n').filter(Boolean) : []
  throw new Error(
    `合并有冲突，已中止合并（仓库保持原样）。冲突文件：${list.slice(0, 10).join('、') || '（读不到）'}。` +
      '这种情况需要人来决定保留哪边。',
  )
}

/**
 * 完整同步：提交自己的 → 推上去 → 拉最新的下来合并 → 如果合并带回了新的本地提交再推一次。
 *
 * @param {{ message?: string }} [options]
 */
export async function syncCode({ message = '' } = {}) {
  const started = Date.now()
  const report = { committed: 0, pushed: false, pulled: false, branch: '', skipped: '' }

  const before = await gitStatus()
  if (!before.ok) throw new Error(before.reason)
  report.branch = before.branch

  // 1. 本地改动先提交，免得 pull 因为工作区脏而失败
  const commitMessage = String(message ?? '').trim() || `chore: 自动同步 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const commit = await commitLocal(commitMessage)
  report.committed = commit.files

  // 2. 推上去
  const statusAfterCommit = await gitStatus()
  if (statusAfterCommit.ok && (statusAfterCommit.ahead > 0 || !statusAfterCommit.hasUpstream)) {
    const pushed = await pushBranch()
    report.pushed = true
    report.branch = pushed.branch
  }

  // 3. 拉远端合并
  const pulled = await pullMerge()
  report.pulled = pulled.merged
  if (pulled.reason) report.skipped = pulled.reason

  // 4. 合并带来的新提交（ff 不会有，merge 会有）再推一次
  if (pulled.merged && pulled.mode === 'merge') {
    const after = await gitStatus()
    if (after.ok && after.ahead > 0) {
      await pushBranch()
      report.pushed = true
    }
  }

  report.seconds = Math.round((Date.now() - started) / 1000)
  return report
}

/** 描述一次同步的结果，给人看 */
export function describeSync(report) {
  if (!report) return '没有同步记录'
  const parts = []
  if (report.committed > 0) parts.push(`提交 ${report.committed} 个文件`)
  if (report.pushed) parts.push(`已推送 ${report.branch}`)
  if (report.pulled) parts.push('已拉取合并')
  if (report.skipped) parts.push(report.skipped)
  if (parts.length === 0) parts.push('没有改动，远端也没更新')
  return `${parts.join('，')}（${report.seconds ?? 0} 秒）`
}

/**
 * 定时同步。内部吞掉异常只记日志——一次同步失败不该影响机器人干活。
 * @param {number} minutes 间隔分钟数，0 表示关闭
 */
export function startAutoSync(minutes) {
  const interval = Number(minutes)
  if (!(interval > 0)) return null

  let running = false

  const tick = async () => {
    if (running) return // 上一次还没跑完，跳过这一轮
    running = true
    try {
      const report = await syncCode()
      if (report.committed > 0 || report.pushed || report.pulled) {
        log.info(`[同步] ${describeSync(report)}`)
      }
    } catch (error) {
      log.warn(`[同步] 失败：${error?.message ?? error}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, interval * 60_000)
  timer.unref?.()

  log.info(`[同步] 每 ${interval} 分钟自动提交并推送，同时拉取远端更新`)

  // 启动 1 分钟后先跑一次，别等到第一个整点
  const kick = setTimeout(tick, 60_000)
  kick.unref?.()

  return timer
}
