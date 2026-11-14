// shell 命令安全检查：独立成模块，纯函数，可单测。
// 思路不是「穷举所有危险命令」，而是先把写法归一化，再匹配。
// 光靠正则匹配原文，`r''m`、`ｒｍ`、`.e''nv` 这类写法都能绕过去。

// 敏感路径：读了就要警惕
const SENSITIVE_PATH = /(\.env\b|data\/|id_rsa|\.ssh\/|authorized_keys|\/etc\/(passwd|shadow|sudoers))/i

// 外传工具：命令里同时出现敏感路径和这些，基本就是往外偷
const EXFIL_TOOL = /\b(curl|wget|nc|ncat|ncat|scp|ssh|ftp|socat)\b/i

const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*\/(\s|$|\*)/, reason: '禁止删除根目录' },
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*(~|\$HOME)(\/|\s|$)/, reason: '禁止删除用户主目录' },
  // 只允许删项目内的相对路径和 /tmp，别把宝塔站点、系统目录一起带走
  {
    pattern: /rm\s+(-[a-zA-Z]+\s+)*\/(?!tmp\/)[^\s]*/,
    reason: '禁止删除项目目录以外的绝对路径（只能删项目内相对路径或 /tmp 下的东西）',
  },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: '禁止 fork 炸弹' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: '禁止关机或重启' },
  { pattern: /\b(mkfs|fdisk|dd\s+if=|dd\s+of=\/dev)/i, reason: '禁止磁盘操作' },
  { pattern: /(cat|less|more|head|tail|grep|strings|awk|sed)[^|;]*\.env(\s|$)/i, reason: '禁止读取 .env' },
  { pattern: /\.env\b[^|;]*$/, reason: '禁止直接操作 .env' },
  { pattern: /\b(ssh-keygen|authorized_keys|id_rsa)\b/i, reason: '禁止操作 SSH 密钥' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//i, reason: '禁止递归改根目录权限' },
  { pattern: /\bchown\s+(-R\s+)?[^\s]+\s+\//i, reason: '禁止递归改根目录属主' },
  { pattern: /^\s*(env|printenv)\s*$/i, reason: '禁止导出全部环境变量（会泄露密钥）' },
  { pattern: /\b(env|printenv)\s*\|\s*/i, reason: '禁止管道导出环境变量（会泄露密钥）' },
  { pattern: /(echo|printf|cat)[^|;]*\$\{?(DEEP_SEEK|DEEPSEEK|QQ_APP|ADMIN_USER)/i, reason: '禁止打印密钥变量' },
  // 记忆和登录凭证：read_file 已经挡了 data/，shell 不能成为绕过它的后门
  {
    pattern: /(cat|less|more|head|tail|grep|strings|awk|sed|type|Get-Content|Select-String)\s[^|;]*data\//i,
    reason: '禁止读取 data/ 目录（对话记忆和登录凭证都在里面）',
  },
  { pattern: /(credentials|context_tokens)\.json/i, reason: '禁止读取登录凭证文件' },
  // Windows 上 `type data\memory.json` 的反斜杠在归一化时会被删掉，
  // 上一条（依赖 data/ 前缀）挡不住，所以按文件名再兜一层
  {
    pattern: /(memory|tickets|schedules|activity|music-cache)\.json/i,
    reason: '禁止读取 data/ 下的记忆和状态文件',
  },
  // 系统里的密钥和账号文件：装了 shell 就等于什么都能读，这几条是最常被拿去外传的
  {
    pattern: /(cat|head|tail|less|more|strings|type)\s[^|;]*(id_rsa|id_ed25519|\.ssh\/|authorized_keys)/i,
    reason: '禁止读取 SSH 密钥',
  },
  {
    pattern: /(cat|head|tail|less|more|type)\s[^|;]*\/etc\/(passwd|shadow|sudoers)/i,
    reason: '禁止读取系统账号文件',
  },
]

/**
 * 把命令压成「匹配用的形态」：
 * - NFKC：全角 ｒｍ 变 rm
 * - 去零宽字符：防不可见字符插在中间
 * - 去引号和反斜杠：r''m / r\m 变 rm
 * - 空白归一：
 * 注意这只用于匹配，实际执行的还是原始命令。
 */
export function normalizeForMatch(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/['"`]/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 检查一条命令能不能跑。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function inspectCommand(raw) {
  const original = String(raw ?? '')
  if (!original.trim()) return { ok: false, reason: '命令为空' }

  const text = normalizeForMatch(original)

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(text)) return { ok: false, reason }
  }

  // 敏感路径 + 外传工具出现在同一条命令里：可能是把密钥/数据往外发
  if (SENSITIVE_PATH.test(text) && EXFIL_TOOL.test(text)) {
    return { ok: false, reason: '命令里同时出现敏感路径和外传工具，疑似往外发送数据' }
  }

  return { ok: true }
}
