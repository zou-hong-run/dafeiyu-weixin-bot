import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defaultEnvFile } from '../ops/platform.js'

// 环境变量的唯一加载点。
//
// 单独成文件是因为顺序问题：ESM 的 import 会整体提升，如果每个模块自己
// 在文件末尾调 dotenv，那么先被 import 的模块读到的还是空环境。
// 放在这里，任何模块 import 它（直接或间接）都保证环境已就绪。

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 密钥优先从项目外读（Linux 上是 /etc/wechatbot/env，或用 APP_ENV_FILE 指定），
// 项目根的 .env 只做兜底。这样即使项目目录被静态托管暴露，也拿不到密钥。
const externalEnv = process.env.APP_ENV_FILE?.trim() || defaultEnvFile()
config({ path: [externalEnv, path.join(projectRoot, '.env')], quiet: true })
