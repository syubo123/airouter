// API key 管理 API（挂载于 /admin/api/keys，全部需要管理员登录）
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { adminAuth } from './auth'
import type { ApiKeyRow } from '../types'

/** key 表 DB 行（enabled 为整型） */
interface KeyDbRow {
  id: number
  name: string
  key: string
  enabled: number
  last_used_at: string | null
  created_at: string
}

/**
 * DB 行解码为 ApiKeyRow
 * @param row DB 原始行
 */
function rowToKey(row: KeyDbRow): ApiKeyRow {
  return { ...row, enabled: row.enabled === 1 }
}

/** key 随机字符集（base62） */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 生成 API key：sk- + 43 位 base62 随机串（32 字节熵，拒绝采样避免模偏差）
 */
export function generateApiKey(): string {
  const len = 43
  const max = 248 // 62*4，256 内最大的 62 倍数
  let out = ''
  const buf = new Uint8Array(len * 2)
  while (out.length < len) {
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < max) out += ALPHABET[b % 62]
      if (out.length === len) break
    }
  }
  return `sk-${out}`
}

/** key 管理子应用 */
export const keysApi = new Hono<AppEnv>()

// 全部 key 路由需要管理员登录
keysApi.use('*', adminAuth)

// key 列表
keysApi.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM api_keys ORDER BY id DESC').all<KeyDbRow>()
  return c.json((results ?? []).map(rowToKey))
})

// 新建 key（入参仅备注名，密钥服务端生成）
keysApi.post('/', async (c) => {
  const body = (await c.req.json<{ name?: unknown }>().catch(() => null)) as { name?: unknown } | null
  const name = body?.name
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 128) {
    return c.json({ error: '备注名必须为 1-128 个字符' }, 400)
  }
  const key = generateApiKey()
  const res = await c.env.DB.prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').bind(name.trim(), key).run()
  const row = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(res.meta.last_row_id).first<KeyDbRow>()
  return c.json(rowToKey(row!))
})

// 修改 key（备注名 / 启用状态）
keysApi.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '无效 id' }, 400)
  const body = (await c.req.json<{ name?: unknown; enabled?: unknown }>().catch(() => null)) as
    | { name?: unknown; enabled?: unknown }
    | null
  if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
  if (typeof body.name === 'string') {
    if (body.name.trim().length < 1 || body.name.length > 128) return c.json({ error: '备注名必须为 1-128 个字符' }, 400)
    await c.env.DB.prepare('UPDATE api_keys SET name = ? WHERE id = ?').bind(body.name.trim(), id).run()
  }
  if (typeof body.enabled === 'boolean') {
    await c.env.DB.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, id).run()
  }
  const row = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<KeyDbRow>()
  if (!row) return c.json({ error: 'key 不存在' }, 404)
  return c.json(rowToKey(row))
})

// 删除 key
keysApi.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '无效 id' }, 400)
  const res = await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run()
  if (res.meta.changes === 0) return c.json({ error: 'key 不存在' }, 404)
  return c.json({ ok: true })
})
