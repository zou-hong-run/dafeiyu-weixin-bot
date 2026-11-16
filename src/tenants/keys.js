// 会话键。
//
// 一定要带账号前缀：微信 userId 看起来全局唯一，但**同一个微信号可以先后扫
// 两个不同 ClawBot 的码**——那样两个租户收到的是同一个 from_user_id，
// 只用 `user:<id>` 的话记忆、工单、活跃度就全串在一起了：
// 在 A 号里说的话，B 号会当成自己聊过。

/**
 * @param {string} tenantId 账号 id
 * @param {string} userId 微信用户 id
 * @returns {string} 形如 `wx-abc:user:o9cq...@im.wechat`；缺参数时退回空串
 */
export function userKey(tenantId, userId) {
  const tenant = String(tenantId ?? '').trim()
  const user = String(userId ?? '').trim()
  if (!user) return ''
  return tenant ? `${tenant}:user:${user}` : `user:${user}`
}

/** 从会话键里取出微信用户 id（工单恢复、定时推送要用） */
export function userIdOf(key) {
  const text = String(key ?? '')
  const at = text.lastIndexOf(':user:')
  if (at >= 0) return text.slice(at + 6)
  return text.replace(/^user:/, '')
}
