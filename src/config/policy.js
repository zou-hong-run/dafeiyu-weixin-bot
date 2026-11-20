import { env } from './env.js'

// 工具权限表。
//
// 微信只有私聊，所以 QQ 版那套 private/group 双 scope 全砍了，
// 但「高危工具走白名单」这条底线保留——它是防止模型被诱导执行
// 任意命令、改任意文件的最后一道闸。

const OPEN = { readOnly: false }
const READ_ONLY = { readOnly: true }

/**
 * 高危工具：能执行命令、改文件、装包、重启进程的一律走白名单。
 * 另外记忆类也在里面——清掉记忆是不可逆的，不该被顺手调用。
 */
export const DANGEROUS_TOOLS = new Set([
  'shell',
  'run_script',
  'write_file',
  'edit_file',
  'restart_self',
  'clear_memory',
  // 扩展能力：注册外部服务、装包——它们影响的是整个进程，不是某一次对话
  'add_mcp',
  'remove_mcp',
  'install_package',
  // 推代码会动远端仓库，不是随手能做的事
  'git_sync',
])

/**
 * 兜底：名字里带这些词的 MCP 工具一律按高危处理。
 * 以后 add_mcp 之类注册进来的新工具，命中能力词也走白名单，不作为例外。
 */
const DANGEROUS_WORDS = new Set([
  'write', 'copy', 'edit', 'exec', 'run', 'install', 'spawn', 'shell',
  'delete', 'remove', 'move', 'rename', 'kill', 'restart', 'upload', 'save',
])

function normalizeToolName(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s]+/g, '_')
    .toLowerCase()
}

/**
 * 名字里带敏感词、但实际无害的工具。
 *
 * 清单只是模型自己的进度记录，不碰文件也不执行命令——按单词匹配的话
 * `todo_write` 会被当成「写文件」类工具，对非管理员直接拒绝，
 * 结果就是清单功能对所有人都不可用。
 */
const SAFE_TOOLS = new Set([
  'todo_write',
  'exit_plan_mode',
  // 技能只影响自己的会话，名字里的 write/delete 是误伤
  'write_skill',
  'delete_skill',
  // 定时任务：只能动自己会话的任务，而且 removeSchedule 自己会验创建者身份，
  // 不靠白名单兜底。按单词匹配的话 remove 会被当成删文件
  'remove_schedule',
])

/** 这个工具要不要走白名单：先看名单，再看名字里的能力词 */
export function isDangerousTool(name) {
  const toolName = String(name ?? '')
  if (SAFE_TOOLS.has(toolName)) return false
  if (DANGEROUS_TOOLS.has(toolName)) return true
  return normalizeToolName(toolName)
    .split('_')
    .filter(Boolean)
    .some((part) => DANGEROUS_WORDS.has(part))
}

/**
 * 管理员判定（决定高危工具能不能用）。
 *
 * 三种情况，按优先级：
 *   1. 配了 ADMIN_USER_IDS  → 只认名单里的 id
 *   2. 没配但 ALLOW_DANGEROUS=true → 放行（单人自用，明确自己开的）
 *   3. 都没配 → 拒绝
 *
 * 注意第 3 条：以前默认放行，等于「没配置」=「对所有人开放」。
 * 安全边界上这是个坏默认——少配一个环境变量，写文件和执行命令就全开了。
 */
export function isAdmin(actor = '') {
  const admins = env.adminUserIds
  if (admins.length > 0) return Boolean(actor) && admins.includes(String(actor))
  return env.allowDangerous
}

/** 调用后要留痕的工具：能改代码、能跑命令的都要 */
export const AUDITED_TOOLS = new Set([
  'shell',
  'run_script',
  'restart_self',
  'write_file',
  'edit_file',
  'clear_memory',
])

export const TOOL_POLICY = {
  // 只读的联网 / 计算 / 查询
  search: READ_ONLY,
  fetch: READ_ONLY,
  now: READ_ONLY,
  system_info: READ_ONLY,
  weather: READ_ONLY,
  exchange: READ_ONLY,
  calc: READ_ONLY,
  timezone: READ_ONLY,
  dns: READ_ONLY,

  // 文件
  read_file: READ_ONLY,
  list_dir: READ_ONLY,
  read_document: READ_ONLY,
  write_file: OPEN,
  edit_file: OPEN,

  // 任务清单（模型自己记进度用，不涉及外部副作用）
  todo_write: OPEN,
  // 规划模式的出口：只是把方案交出来，不动系统
  exit_plan_mode: OPEN,

  // 技能（按会话隔离，只影响自己）
  write_skill: OPEN,
  list_skills: READ_ONLY,
  read_skill: READ_ONLY,
  delete_skill: OPEN,

  // 代码同步
  git_sync: OPEN,
  git_status: READ_ONLY,

  // 定时任务：只能指向当前会话自己的主人，加不出「给别人发广告」这种事，
  // 数量也有上限（每会话 5 个、全局 20 个）兜着，所以不进高危名单
  schedule_task: OPEN,
  list_schedule: READ_ONLY,
  remove_schedule: OPEN,

  // 扩展能力（前三个是真高危，靠 DANGEROUS_TOOLS 拦）
  add_mcp: OPEN,
  list_mcp: READ_ONLY,
  remove_mcp: OPEN,
  install_package: OPEN,

  // 记忆
  remember: OPEN,
  recall_memory: READ_ONLY,
  forget_memory: OPEN,
  list_memory: READ_ONLY,
  clear_memory: OPEN,

  // 其它
  download: OPEN,
  draw_pixel: OPEN,

  // 媒体发送（微信没有语音消息；音频走文件通道，自动转 mp3）
  send_image: OPEN,
  send_file: OPEN,
  send_video: OPEN,
  send_audio: OPEN,

  // 音乐 / 视频解析（yt-dlp）
  find_music: READ_ONLY,
  find_video: READ_ONLY,
  fetch_video: READ_ONLY,
  read_video_subtitle: READ_ONLY,
  video_meta: READ_ONLY,

  // 高危
  shell: OPEN,
  run_script: OPEN,
  restart_self: OPEN,
}

export function isToolAllowed(toolName, actor = '') {
  if (isDangerousTool(toolName)) return isAdmin(actor)

  // 未知工具默认拒绝：注册进来的服务不自动获得权限，要在表里显式加条目
  if (!TOOL_POLICY[toolName]) return false
  return true
}

/** 被拒时给出可执行的原因，别只回一句「不可用」 */
export function denyReason(toolName, actor = '') {
  if (isDangerousTool(toolName)) {
    if (env.adminUserIds.length > 0) {
      return (
        `工具 ${toolName} 需要管理员权限：你的 id ${actor || '未知'} 不在 ADMIN_USER_IDS 名单里。` +
        '把串 id 加进 .env 后重启即可。'
      )
    }
    return (
      `工具 ${toolName} 属于高危操作，当前没有开放。` +
      '要么在 .env 里配 ADMIN_USER_IDS=<你的 id>，要么设 ALLOW_DANGEROUS=true（只建议单人自用时开）'
    )
  }
  return `工具 ${toolName} 不可用`
}

export function filterTools(tools, actor = '') {
  return tools.filter((tool) => isToolAllowed(tool.name, actor))
}

export function describePolicy(toolNames) {
  return toolNames
    .map((name) => `${name}${isDangerousTool(name) ? '(仅管理员)' : ''}`)
    .join(' ')
}

export function describeAdminPolicy() {
  const admins = env.adminUserIds
  if (admins.length > 0) return `高危工具仅限 ${admins.length} 个白名单 id（ADMIN_USER_IDS）`
  if (env.allowDangerous) {
    return '未设 ADMIN_USER_IDS，但 ALLOW_DANGEROUS=true：高危工具对所有人开放，仅适合单人自用'
  }
  return '高危工具已禁用（shell / 写文件 / 清记忆等）。要开放：配 ADMIN_USER_IDS，或设 ALLOW_DANGEROUS=true'
}
