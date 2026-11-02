// 网关 API key 鉴权中间件（/v1/* 全部走这里，与管理员会话完全独立）
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import type { AppEnv } from '../env'

/**
 * 构造 401 响应（OpenAI 风格错误体）
 * @param c 请求上下文
 */
function unauthorized(c: Context<AppEnv>): Response {
  return c.json({ error: { message: '无效的 API key', type: 'invalid_request_error' } }, 401)
}

/**
 * key 鉴权中间件：取 Authorization: Bearer <key> 或 x-api-key: <key>，
 * 校验存在且启用；命中注入 keyName 并刷新 last_used_at，未命中 401
 */
export const keyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.req.header('Authorization')
  let key: string | undefined
  if (auth?.startsWith('Bearer ')) key = auth.slice(7).trim()
  key = key || c.req.header('x-api-key')
  if (!key) return unauthorized(c)

  const row = await c.env.DB.prepare('SELECT id, name, enabled FROM api_keys WHERE key = ?')
    .bind(key)
    .first<{ id: number; name: string; enabled: number }>()
  if (!row || row.enabled !== 1) return unauthorized(c)

  c.set('keyName', row.name)
  await c.env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(row.id).run()
  await next()
})
