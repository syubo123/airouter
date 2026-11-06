// 渠道管理 API（挂载于 /admin/api/channels，全部需要管理员登录）
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { adminAuth } from './auth'
import { upstreamMethodPath } from '../gateway/upstream'
import type { Channel } from '../types'

/** 渠道表行（DB 原始形态，models/model_mapping 为 JSON 字符串） */
interface ChannelDbRow {
  id: number
  name: string
  type: string
  base_url: string
  api_key: string
  models: string
  model_mapping: string
  priority: number
  supports_responses: number
  enabled: number
  created_at: string
  updated_at: string
}

/**
 * DB 行解码为 Channel（解析 JSON 字段、布尔化整型）
 * @param row DB 原始行
 */
export function rowToChannel(row: ChannelDbRow): Channel {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Channel['type'],
    base_url: row.base_url,
    api_key: row.api_key,
    models: JSON.parse(row.models) as string[],
    model_mapping: JSON.parse(row.model_mapping) as Record<string, string>,
    priority: row.priority,
    supports_responses: row.supports_responses === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** 渠道载荷校验结果：合法返回可直接入库的字段，非法返回错误信息 */
type ValidatedChannel = Omit<Channel, 'id' | 'created_at' | 'updated_at'>

/**
 * 校验并规范化渠道载荷（anthropic 类型强制 supports_responses=false）
 * @param body 请求体
 * @returns [规范化字段, undefined] 或 [undefined, 错误信息]
 */
function validateChannel(body: Record<string, unknown>): [ValidatedChannel, undefined] | [undefined, string] {
  const name = body.name
  const type = body.type
  const base_url = body.base_url
  const api_key = body.api_key
  const models = body.models
  const model_mapping = body.model_mapping ?? {}
  const priority = body.priority ?? 0
  const supports_responses = body.supports_responses ?? false
  const enabled = body.enabled ?? true
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 128) return [undefined, '渠道名必须为 1-128 个字符']
  if (type !== 'openai' && type !== 'anthropic') return [undefined, 'type 只能是 openai 或 anthropic']
  if (typeof base_url !== 'string' || !/^https?:\/\//.test(base_url) || base_url.length > 2048) return [undefined, 'base_url 必须是 http(s) 地址']
  if (typeof api_key !== 'string' || api_key.length < 1) return [undefined, 'api_key 不能为空']
  if (!Array.isArray(models) || models.length < 1 || models.some((m) => typeof m !== 'string' || m.length < 1)) {
    return [undefined, 'models 必须是非空字符串数组']
  }
  if (typeof model_mapping !== 'object' || model_mapping === null || Array.isArray(model_mapping)) {
    return [undefined, 'model_mapping 必须是对象']
  }
  for (const v of Object.values(model_mapping)) {
    if (typeof v !== 'string' || v.length < 1) return [undefined, 'model_mapping 的值必须是非空字符串']
  }
  if (typeof priority !== 'number' || !Number.isInteger(priority)) return [undefined, 'priority 必须是整数']
  return [
    {
      name: name.trim(),
      type,
      base_url: base_url.replace(/\/+$/, ''), // 去尾部斜杠，拼接路径时统一
      api_key,
      models: models as string[],
      model_mapping: model_mapping as Record<string, string>,
      priority,
      supports_responses: type === 'openai' ? supports_responses === true : false,
      enabled: enabled === true,
    },
    undefined,
  ]
}

/** 渠道管理子应用 */
export const channelsApi = new Hono<AppEnv>()

// 全部渠道路由需要管理员登录
channelsApi.use('*', adminAuth)

// 渠道列表
channelsApi.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM channels ORDER BY priority ASC, id ASC').all<ChannelDbRow>()
  return c.json((results ?? []).map(rowToChannel))
})

// 新建渠道
channelsApi.post('/', async (c) => {
  const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as Record<string, unknown> | null
  if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
  const [ch, err] = validateChannel(body)
  if (err || !ch) return c.json({ error: err }, 400)
  const res = await c.env.DB.prepare(
    'INSERT INTO channels (name, type, base_url, api_key, models, model_mapping, priority, supports_responses, enabled) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(ch.name, ch.type, ch.base_url, ch.api_key, JSON.stringify(ch.models), JSON.stringify(ch.model_mapping), ch.priority, ch.supports_responses ? 1 : 0, ch.enabled ? 1 : 0)
    .run()
  const row = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(res.meta.last_row_id).first<ChannelDbRow>()
  return c.json(rowToChannel(row!))
})

// 更新渠道（整体替换可编辑字段）
channelsApi.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '无效 id' }, 400)
  const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as Record<string, unknown> | null
  if (!body) return c.json({ error: '请求体必须是 JSON' }, 400)
  const [ch, err] = validateChannel(body)
  if (err || !ch) return c.json({ error: err }, 400)
  const res = await c.env.DB.prepare(
    'UPDATE channels SET name=?, type=?, base_url=?, api_key=?, models=?, model_mapping=?, priority=?, supports_responses=?, enabled=?, updated_at=datetime(\'now\') WHERE id=?',
  )
    .bind(ch.name, ch.type, ch.base_url, ch.api_key, JSON.stringify(ch.models), JSON.stringify(ch.model_mapping), ch.priority, ch.supports_responses ? 1 : 0, ch.enabled ? 1 : 0, id)
    .run()
  if (res.meta.changes === 0) return c.json({ error: '渠道不存在' }, 404)
  const row = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelDbRow>()
  return c.json(rowToChannel(row!))
})

// 删除渠道
channelsApi.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '无效 id' }, 400)
  const res = await c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run()
  if (res.meta.changes === 0) return c.json({ error: '渠道不存在' }, 404)
  return c.json({ ok: true })
})

// 从上游拉取可用模型列表（新建/编辑渠道时供多选；OpenAI 单页，Anthropic 分页聚合）
channelsApi.post('/fetch-models', async (c) => {
  const body = (await c.req.json<Record<string, unknown>>().catch(() => null)) as Record<string, unknown> | null
  const type = body?.type
  const baseUrl = body?.base_url
  const apiKey = body?.api_key
  if ((type !== 'openai' && type !== 'anthropic') || typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || typeof apiKey !== 'string' || apiKey.length < 1) {
    return c.json({ error: 'type、base_url（http s）、api_key 均为必填且合法' }, 400)
  }
  const headers: Record<string, string> =
    type === 'openai'
      ? { Authorization: `Bearer ${apiKey}` }
      : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  const modelsUrl = `${baseUrl}${upstreamMethodPath(baseUrl, 'models')}`
  const ids = new Set<string>()
  let lastStatus = 0
  let lastError = ''

  try {
    // Anthropic 的 /models 有分页（has_more/last_id），最多跟随 10 页；OpenAI 单页
    let afterId: string | undefined
    for (let page = 0; page < (type === 'anthropic' ? 10 : 1); page++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      const sep = modelsUrl.includes('?') ? '&' : '?'
      const url = afterId ? `${modelsUrl}${sep}limit=100&after_id=${encodeURIComponent(afterId)}` : `${modelsUrl}${sep}limit=100`
      const resp = await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
      clearTimeout(timer)
      lastStatus = resp.status
      if (!resp.ok) {
        lastError = (await resp.text().catch(() => '')).slice(0, 300)
        break
      }
      const json = (await resp.json().catch(() => null)) as { data?: Array<{ id?: string } | string>; has_more?: boolean; last_id?: string } | null
      if (!json || !Array.isArray(json.data)) {
        lastError = '上游返回的模型列表格式无法识别'
        break
      }
      for (const item of json.data) {
        const id = typeof item === 'string' ? item : item?.id
        if (typeof id === 'string' && id) ids.add(id)
      }
      if (json.has_more && json.last_id) {
        afterId = json.last_id
        continue
      }
      break
    }
  } catch (e) {
    return c.json({ ok: false, status: 0, error: `连接失败：${(e as Error).message}`, url: modelsUrl })
  }

  if (ids.size === 0) {
    return c.json({ ok: false, status: lastStatus, error: lastError || '上游未返回任何模型', url: modelsUrl })
  }
  return c.json({ ok: true, models: [...ids].sort() })
})

// 连通性测试：向该渠道上游发最小非流式请求（模型取列表第一个并应用改名映射）
channelsApi.post('/:id/test', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelDbRow>()
  if (!row) return c.json({ error: '渠道不存在' }, 404)
  const ch = rowToChannel(row)
  const model = ch.model_mapping[ch.models[0]] ?? ch.models[0]
  const started = Date.now()
  // 按渠道 base_url 形态适配版本前缀（纯域名补 /v1，带路径只拼方法路径）
  const methodPath = ch.type === 'openai' ? upstreamMethodPath(ch.base_url, 'chat') : upstreamMethodPath(ch.base_url, 'messages')
  let resp: Response
  try {
    if (ch.type === 'openai') {
      resp = await fetch(`${ch.base_url}${methodPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${ch.api_key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      })
    } else {
      resp = await fetch(`${ch.base_url}${methodPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ch.api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      })
    }
  } catch (e) {
    return c.json({ ok: false, status: 0, elapsed_ms: Date.now() - started, error: `连接失败：${(e as Error).message}`, url: `${ch.base_url}${methodPath}` })
  }
  const text = await resp.text()
  if (resp.ok) return c.json({ ok: true, status: resp.status, elapsed_ms: Date.now() - started })
  return c.json({ ok: false, status: resp.status, elapsed_ms: Date.now() - started, error: text.slice(0, 500), url: `${ch.base_url}${methodPath}` })
})
