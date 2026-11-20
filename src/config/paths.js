import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './dotenv.js'

// 路径解析。
//
// 为什么要能外置：代码目录和数据目录绑在一起的话，升级代码时
// `git clean -fdx`、重装、换分支这些操作都可能把用户数据带走。
// 分开之后代码目录随便折腾，数据在自己的地方。
//
// 每个目录都可以用环境变量指到别处，不配就用项目内的默认位置——
// 单人自用不需要配，多实例部署时才需要。

function resolveDir(envKey, fallbackName) {
  const custom = process.env[envKey]?.trim()
  if (!custom) return path.join(projectRoot, fallbackName)
  return path.isAbsolute(custom) ? custom : path.resolve(projectRoot, custom)
}

/**
 * 分三类：
 *   · data      —— 凭证、记忆、工单、定时任务、MCP 注册表、规划方案（丢了很麻烦）
 *   · skills    —— 用户让写的技能（丢了要重写）
 *   · 其它      —— 下载、日志、临时文件（丢了无所谓）
 */
export const paths = {
  projectRoot,

  /** 数据根目录：DATA_DIR */
  data: resolveDir('DATA_DIR', 'data'),
  /** 技能目录：SKILLS_DIR */
  skills: resolveDir('SKILLS_DIR', 'skills'),
  /** 下载目录：DOWNLOADS_DIR */
  downloads: resolveDir('DOWNLOADS_DIR', 'downloads'),
  /** 日志目录：LOGS_DIR */
  logs: resolveDir('LOGS_DIR', 'logs'),
  /** 临时目录：TMP_DIR */
  tmp: resolveDir('TMP_DIR', 'tmp'),
}

/** 数据类路径的快捷方式 */
export const dataPath = {
  ilink: path.join(paths.data, 'ilink'),
  tenants: path.join(paths.data, 'tenants'),
  memory: path.join(paths.data, 'memory.json'),
  tickets: path.join(paths.data, 'tickets.json'),
  schedules: path.join(paths.data, 'schedules.json'),
  activity: path.join(paths.data, 'activity.json'),
  todos: path.join(paths.data, 'todos.json'),
  plans: path.join(paths.data, 'plans.json'),
  registry: path.join(paths.data, 'mcp-registry.json'),
  musicCache: path.join(paths.data, 'music-cache.json'),
  cookies: path.join(paths.data, 'cookies.txt'),
  instanceLock: path.join(paths.data, 'instance.lock'),
}

/** 启动时把该有的目录建出来 */
export function ensureDirs() {
  for (const dir of [paths.data, paths.skills, paths.downloads, paths.logs, paths.tmp]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
