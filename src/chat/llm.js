import OpenAI from 'openai'
import { env } from '../config/env.js'
import { createLimiter } from './limiter.js'

// 模型调用的统一入口。
//
// 三个地方（对话、工单、压缩）原来各自 new 了一个 OpenAI client，
// 配置全是默认值：超时 10 分钟、重试 2 次、完全不限并发。
// 多用户同时聊的时候，卡住的请求会一直占着额度，撞限流又一起重试。

export const llmLimiter = createLimiter('llm', env.llmConcurrency)

const client = new OpenAI({
  apiKey: env.apiKey,
  baseURL: env.baseURL,
  // 429 / 5xx 自动重试，SDK 内部带随机退避，避免所有请求同时重试
  maxRetries: 3,
  // 默认 10 分钟太长：一个卡死的请求会占着并发额度，后面的人全在排队
  timeout: 180_000,
})

/**
 * 调一次模型。
 * 并发受 llmLimiter 控制，超时和重试由 client 负责。
 *
 * @param {object} body chat.completions.create 的参数
 */
export function complete(body) {
  return llmLimiter.run(() => client.chat.completions.create(body), {
    onWait: (ms) => {
      // 排队超过 3 秒说明并发打满了，值得记一笔——长期频繁出现就该调大 LLM_CONCURRENCY
      if (ms > 3000) console.warn(`[限流] 模型调用排队 ${Math.round(ms / 1000)} 秒`)
    },
  })
}
