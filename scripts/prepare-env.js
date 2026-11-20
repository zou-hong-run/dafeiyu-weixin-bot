import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试和检查脚本共用的环境准备。
//
// 单独成文件的原因：这个前提太容易被漏掉——CI 上没有 .env，
// 业务模块 import 到 env.js 时看到 DEEP_SEEK_API_KEY 缺失就直接
// process.exit(1)，测试根本没开始跑，报错还看不出原因。
// 之前 check.js 里设了一份，新加的 test.js 忘了，CI 红了三次才定位到。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 在 import 业务模块之前调用。
 * @returns {string} 项目根目录
 */
export function prepareTestEnv() {
  // 只是为了让 env.js 的必填校验过掉，不会发起任何真实请求
  if (!process.env.DEEP_SEEK_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    process.env.DEEP_SEEK_API_KEY = 'test-placeholder'
  }

  // 授权变量必须清空：policy 测试要验证「未配白名单时默认拒绝」，
  // 本机配过 ADMIN_USER_IDS 的话那条断言会假失败
  process.env.ADMIN_USER_IDS = ''
  process.env.ALLOW_DANGEROUS = 'false'

  // 落盘都往 tmp 里写，别碰真实的 data/ 和 downloads/。
  // DATA_DIR 也要改：有些模块（活跃度、清单、方案）加载时就会读写 data/ 下的文件
  process.env.DATA_DIR ||= path.join(projectRoot, 'tmp', 'test', 'data')
  process.env.TMP_DIR ||= path.join(projectRoot, 'tmp', 'test')

  return projectRoot
}
