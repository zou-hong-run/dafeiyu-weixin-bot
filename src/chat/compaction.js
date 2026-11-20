import { env } from '../config/env.js'
import { complete } from './llm.js'
import { log } from '../ops/logger.js'

// 上下文压缩。
//
// 核心思路：**压缩不是摘要，是交接**——下一轮只能看到保留下来的消息
// 加上这份摘要，其他全部消失。所以要在「最后一次拥有全部上下文」的时刻，
// 把决定、结论、后续计划固化下来，而不是写一段概括了事的文字。
//
// 我们原来的版本是「压成 200 字以内的摘要」，丢掉太多：具体数值没了、
// 报错原文没了、做过什么只剩一句「已查过资料」，下一轮等于重新开始。

const COMPACTION_PROMPT = `你即将失去上下文。给接手这件事的模型写一份交接摘要。

这段对话之后会被清空，下一轮只能看到保留的最近几条消息和这份摘要。

用你自己的话写，保留这些：

- 对方最新要求的真实意图，以及你已经澄清过的歧义。不要把原话再抄一遍——如果它被保留下来了，那里就有原文；如果太长被截断了，把被截掉的关键部分补上。
- 当前生效的约束：对方的偏好、项目规则、环境限制。已经定下来的结论和还没定的问题要分开写，别让下一轮把定了的重新讨论、把没定的当成定了。
- 实际做过什么，要具体：执行过的命令原文、动过的文件路径、成功还是失败，**以及拿到的具体结果**——返回的数值、关键行、报错原文、查到的接口签名。这些重跑可能很慢甚至重跑不了。代码只保留最终能用的版本，中间的试错和已经解决的报错丢掉。
- 还不知道什么：提到但没读的文件、假设但没验证的接口、对方还没回答的问题。写清楚，让下一轮去查而不是想当然。
- 接下来的计划——这里值得多花点力气。你现在对这件事的了解是最全的，下一轮只有这份摘要。写清楚下一步具体做什么，后面还有哪几步，你已经替后面做过的决定，能预见的坑打算怎么绕。你在这里定下来的每件事，都是下一轮不用重新想的事。

诚实一点：前面有谁声称做完了但其实没验证的（测试"通过了"、问题"修好了"、文件"创建了"），明确标成「未验证」，别当成事实。

简洁点，跟事情的大小相称：几句话能说清的就别铺开。关键标识符、具体数值、报错行要留，不影响下一步的细节都省略。

不用抄任务清单，它会自动带上。
只输出摘要正文，不要调用工具，不要说「好的，这是摘要」。`


/** 把一串消息渲染成压缩用的对话记录 */
function transcriptOf(messages) {
  return messages
    .map((message) => {
      const role = message.role === 'user' ? '对方' : message.role === 'assistant' ? '我' : '工具结果'
      const body = String(message.content ?? '').trim()
      if (!body) return ''
      return `${role}：${body}`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 压缩一段对话。
 *
 * @param {object} options
 * @param {object[]} options.messages 要压掉的消息
 * @param {string} [options.previousSummary] 上一版摘要。有的话做增量合并，不是覆盖
 * @param {string} [options.extra] 额外要求（比如工单场景：「重点保留已经完成到哪一步」）
 * @returns {Promise<string>} 摘要正文；失败返回空串
 */
export async function compactConversation({ messages, previousSummary = '', extra = '' }) {
  const body = transcriptOf(messages)
  if (!body.trim()) return ''

  const parts = [COMPACTION_PROMPT]

  if (extra.trim()) parts.push(`额外要求：${extra.trim()}`)

  if (previousSummary.trim()) {
    parts.push(
      '这是之前压缩过一次留下的摘要。把它和这次的对话**合并**成一份新摘要，别丢掉旧摘要里还没失效的信息：',
      previousSummary.trim(),
    )
  }

  parts.push('--- 需要压缩的对话 ---', body)

  try {
    const response = await complete({
      model: env.model,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
      // 摘要长度跟任务规模走，给足空间；具体写多少由提示词里的「相称」约束
      max_tokens: 2000,
    })

    return String(response.choices[0]?.message?.content ?? '').trim()
  } catch (error) {
    log.error('[压缩] 调模型失败', { error: error?.message ?? String(error) })
    return ''
  }
}
