// 失败日志与统计 API（挂载于 /admin/api/logs 与 /admin/api/stats，需要管理员登录）
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { adminAuth } from './auth'
import type { FailureLogRow } from '../types'

/** 日志子应用（同时承载 /admin/api/stats） */
export const logsApi = new Hono<AppEnv>()

// 全部路由需要管理员登录
logsApi.use('*', adminAuth)

// 日志列表（倒序，limit 默认 100 上限 500）
logsApi.get('/', async (c) => {
  const limitRaw = Number(new URL(c.req.url).searchParams.get('limit') ?? 100)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100
  const { results } = await c.env.DB.prepare('SELECT * FROM failure_logs ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<FailureLogRow>()
  return c.json(results ?? [])
})

// 清空日志
logsApi.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM failure_logs').run()
  return c.json({ ok: true })
})

/** 统计子应用（挂载于 /admin/api/stats） */
export const statsApi = new Hono<AppEnv>()

// 全部路由需要管理员登录
statsApi.use('*', adminAuth)

// 仪表盘统计：渠道数、key 数、今日失败数
statsApi.get('/', async (c) => {
  const [channels, keys, failures] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM channels').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys').first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM failure_logs WHERE created_at >= date('now', 'start of day')").first<{ n: number }>(),
  ])
  return c.json({ channels: channels!.n, keys: keys!.n, failures_today: failures!.n })
})
