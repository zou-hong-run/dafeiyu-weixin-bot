import fs from 'node:fs'
import { paths, dataPath } from '../config/paths.js'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertMcpCommand } from '../mcp/mcp-guard.js'
import { shellSafeEnv } from './shell-env.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = paths.data
const registryFile = dataPath.registry

// 扩展能力的工具：注册外部 MCP 服务、装 npm 包。
//
// 放在 MCP 子进程里而不是主进程：装包要跑 pnpm，那是会执行脚本的操作，
// 不该发生在承载对话的进程里。
//
// 三道闸门：
//   1. 启动命令必须过 mcp-guard 白名单（只允许 node/npx，脚本必须落在 tools/ 内）
//   2. 注册进来的工具默认不在权限表里，谁都用不了——要用得在 policy.js 显式加一行
//   3. 装包强制 --ignore-scripts，禁掉 postinstall

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeRegistry(list) {
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${registryFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
  fs.renameSync(tmp, registryFile)
}

async function addMcp({ name, command, args = [] } = {}) {
  const safe = String(name ?? '').trim()
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(safe)) {
    throw new Error('name 只能包含字母、数字、下划线、短横线，长度 1-40')
  }
  if (!command) throw new Error('command 必填，目前只允许 node 或 npx')

  const argList = Array.isArray(args) ? args.map(String) : []
  assertMcpCommand(command, argList, { projectRoot })

  const registry = readRegistry()
  // env 一律不存：注册表是个可写文件，能塞环境变量就等于给子进程开权限
  const entry = { name: safe, command: String(command), args: argList, env: {} }
  const index = registry.findIndex((item) => item?.name === safe)

  if (index >= 0) registry[index] = entry
  else registry.push(entry)

  writeRegistry(registry)

  return [
    `已注册 MCP 服务「${safe}」：${command} ${argList.join(' ')}`,
    '主进程会在下一轮对话时尝试连接它。',
    '注意：它带来的新工具默认**没有权限**，谁都用不了——要让某个工具可用，得在 src/config/policy.js 的 TOOL_POLICY 里加一行。',
  ].join('\n')
}

async function listMcp() {
  const registry = readRegistry()
  const lines = []

  if (registry.length === 0) {
    lines.push('除了内置工具，没有额外注册的 MCP 服务。')
  } else {
    lines.push(`已注册 ${registry.length} 个 MCP 服务：`)
    for (const item of registry) {
      lines.push(`- ${item.name}: ${item.command} ${(item.args ?? []).join(' ')}`)
    }
  }

  lines.push('', '内置工具见 /tools。外部服务的工具要手动加进 TOOL_POLICY 才可用。')
  return lines.join('\n')
}

async function removeMcp({ name } = {}) {
  const safe = String(name ?? '').trim()
  if (!safe) throw new Error('要删哪个？传 name')

  const registry = readRegistry()
  const next = registry.filter((item) => item?.name !== safe)
  if (next.length === registry.length) throw new Error(`没有叫「${safe}」的 MCP 服务`)

  writeRegistry(next)
  // 进程重启后才会彻底断开那个服务，这里只是让它从注册表消失
  return `已从注册表删掉「${safe}」。它的工具在重启前可能还能用，重启后彻底消失。`
}

async function installPackage({ package: pkg } = {}) {
  const name = String(pkg ?? '').trim()
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error('包名不合法，只接受 npm 包名格式，如 @scope/name 或 some-package')
  }

  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['add', name, '--ignore-scripts'], {
      cwd: projectRoot,
      timeout: 180_000,
      shell: true,
      maxBuffer: 4 * 1024 * 1024,
      // 不继承本进程环境：包里的脚本可能读 env 找密钥
      env: shellSafeEnv(),
    })
    const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
    return `已安装 ${name}\n${output.slice(-600)}\n\n装完通常还要 add_mcp 把它注册成工具服务。`
  } catch (error) {
    throw new Error(`安装失败：${error?.message ?? error}`)
  }
}

export const EVOLVE_HANDLERS = {
  add_mcp: addMcp,
  list_mcp: listMcp,
  remove_mcp: removeMcp,
  install_package: installPackage,
}

export const EVOLVE_TOOLS = [
  {
    name: 'add_mcp',
    description:
      '注册一个外部 MCP 服务来获取新工具能力。对方说「装个能查数据库的工具」「接一下 xxx 服务」时用。' +
      '通常先 install_package 把包装上，再用 add_mcp 注册。command 只允许 node 或 npx，node 的脚本必须放在项目 tools/ 目录里。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务名，字母数字下划线短横线' },
        command: { type: 'string', description: '启动命令，node 或 npx' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '命令参数，如 ["@modelcontextprotocol/server-memory"]',
        },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'list_mcp',
    description: '列出已注册的外部 MCP 服务。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_mcp',
    description: '从注册表删掉一个外部 MCP 服务。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要删的服务名' } },
      required: ['name'],
    },
  },
  {
    name: 'install_package',
    description:
      '在项目里装一个 npm 包（pnpm add，强制 --ignore-scripts 不跑安装脚本）。' +
      '装完一般还要 add_mcp 注册成工具服务。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'npm 包名，如 @modelcontextprotocol/server-memory' },
      },
      required: ['package'],
    },
  },
]
