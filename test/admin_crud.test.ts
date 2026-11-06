// Task 4：管理 CRUD（渠道/key/日志/统计）集成测试
import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetDb } from './db'
import { stubFetch, type RecordedCall } from './fetchstub'

// 每个测试前重置数据库
beforeEach(resetDb)

/** 已安装的 fetch 桩（afterEach 统一恢复） */
let stubs: Array<{ calls: RecordedCall[]; restore(): void }> = []
afterEach(() => {
  for (const s of stubs) s.restore()
  stubs = []
})

/** 测试用 Worker 地址 */
const base = 'https://example.com'

/** 初始化管理员并登录，返回会话 cookie 头 */
async function login(): Promise<string> {
  await SELF.fetch(`${base}/admin/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  const res = await SELF.fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  })
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

/** 请求辅助：带 cookie 与可选 JSON 体 */
function req(path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** 标准渠道载荷 */
const channelBody = {
  name: '中转A',
  type: 'openai',
  base_url: 'https://up.example.com',
  api_key: 'upk-1',
  models: ['gpt-4o', 'gpt-4o-mini'],
  model_mapping: { 'gpt-4o': 'gpt-4o-2024-08-06' },
  priority: 0,
  supports_responses: true,
  enabled: true,
}

// 渠道 CRUD 全回路：创建（models 解码为数组、supports_responses 布尔）→ 改优先级 → 删除
it('渠道 CRUD 全回路', async () => {
  const cookie = await login()
  const create = await req('/admin/api/channels', cookie, 'POST', channelBody)
  expect(create.status).toBe(200)
  const created = (await create.json()) as Record<string, unknown>
  expect(created.id).toBeGreaterThan(0)
  expect(created.models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  expect(created.model_mapping).toEqual({ 'gpt-4o': 'gpt-4o-2024-08-06' })
  expect(created.supports_responses).toBe(true)

  const list1 = (await (await req('/admin/api/channels', cookie)).json()) as unknown[]
  expect(list1).toHaveLength(1)

  const upd = await req(`/admin/api/channels/${created.id}`, cookie, 'PUT', { ...channelBody, priority: 5 })
  expect(upd.status).toBe(200)
  const list2 = (await (await req('/admin/api/channels', cookie)).json()) as Array<Record<string, unknown>>
  expect(list2[0].priority).toBe(5)

  expect((await req(`/admin/api/channels/${created.id}`, cookie, 'DELETE')).status).toBe(200)
  const list3 = (await (await req('/admin/api/channels', cookie)).json()) as unknown[]
  expect(list3).toHaveLength(0)
})

// anthropic 类型渠道 supports_responses 强制存 false
it('anthropic 渠道 supports_responses 强制为 false', async () => {
  const cookie = await login()
  const res = await req('/admin/api/channels', cookie, 'POST', {
    ...channelBody,
    type: 'anthropic',
    supports_responses: true,
  })
  expect(res.status).toBe(200)
  expect(((await res.json()) as Record<string, unknown>).supports_responses).toBe(false)
})

// 渠道校验：非法 type / base_url / 空 models
it('渠道校验：非法 type、非 http(s) base_url、空 models 返回 400', async () => {
  const cookie = await login()
  expect((await req('/admin/api/channels', cookie, 'POST', { ...channelBody, type: 'gemini' })).status).toBe(400)
  expect((await req('/admin/api/channels', cookie, 'POST', { ...channelBody, base_url: 'ftp://x' })).status).toBe(400)
  expect((await req('/admin/api/channels', cookie, 'POST', { ...channelBody, models: [] })).status).toBe(400)
})

// key 生成（sk- + 43 位）与启停删
it('key 生成、禁用、删除', async () => {
  const cookie = await login()
  const create = await req('/admin/api/keys', cookie, 'POST', { name: '测试key' })
  expect(create.status).toBe(200)
  const row = (await create.json()) as Record<string, unknown>
  expect(row.key).toMatch(/^sk-[A-Za-z0-9]{43}$/)
  expect(row.enabled).toBe(true)

  expect((await req(`/admin/api/keys/${row.id}`, cookie, 'PATCH', { enabled: false })).status).toBe(200)
  const list = (await (await req('/admin/api/keys', cookie)).json()) as Array<Record<string, unknown>>
  expect(list).toHaveLength(1)
  expect(list[0].enabled).toBe(false)

  expect((await req(`/admin/api/keys/${row.id}`, cookie, 'DELETE')).status).toBe(200)
  expect(await (await req('/admin/api/keys', cookie)).json()).toHaveLength(0)
})

// 日志列表与清空；统计数字
it('日志列表与清空，统计数字正确', async () => {
  const cookie = await login()
  expect(await (await req('/admin/api/logs', cookie)).json()).toHaveLength(0)

  await env.DB.prepare(
    "INSERT INTO failure_logs (api_key_name, channel_name, model, endpoint, status, error) VALUES ('k1','c1','m1','openai /v1/chat/completions',500,'boom')",
  ).run()

  const logs = (await (await req('/admin/api/logs', cookie)).json()) as Array<Record<string, unknown>>
  expect(logs).toHaveLength(1)
  expect(logs[0].error).toBe('boom')

  const stats = (await (await req('/admin/api/stats', cookie)).json()) as Record<string, unknown>
  expect(stats).toEqual({ channels: 0, keys: 0, failures_today: 1 })

  expect((await req('/admin/api/logs', cookie, 'DELETE')).status).toBe(200)
  expect(await (await req('/admin/api/logs', cookie)).json()).toHaveLength(0)
})

// 未登录访问任一管理路由 401
it('未登录访问管理路由 401', async () => {
  const cases: Array<[string, string]> = [
    ['GET', '/admin/api/channels'],
    ['POST', '/admin/api/channels'],
    ['GET', '/admin/api/keys'],
    ['POST', '/admin/api/keys'],
    ['GET', '/admin/api/logs'],
    ['DELETE', '/admin/api/logs'],
    ['GET', '/admin/api/stats'],
  ]
  for (const [method, path] of cases) {
    expect((await SELF.fetch(`${base}${path}`, { method })).status).toBe(401)
  }
})

// 渠道连通性测试：上游 200 → ok 与耗时；请求带渠道 key 与改名映射后的模型、max_tokens=1
it('渠道连通性测试：透传上游状态、模型映射生效', async () => {
  const cookie = await login()
  const created = (await (await req('/admin/api/channels', cookie, 'POST', channelBody)).json()) as { id: number }

  const stub = stubFetch([
    (url) =>
      url.pathname === '/v1/chat/completions'
        ? new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'pong' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : null,
  ])
  try {
    const res = await req(`/admin/api/channels/${created.id}/test`, cookie, 'POST')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.status).toBe(200)
    expect(typeof body.elapsed_ms).toBe('number')

    expect(stub.calls).toHaveLength(1)
    const sent = JSON.parse(String(stub.calls[0].init?.body)) as Record<string, unknown>
    expect(sent.model).toBe('gpt-4o-2024-08-06')
    expect(sent.max_tokens).toBe(1)
    const headers = stub.calls[0].init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer upk-1')
  } finally {
    stub.restore()
  }
})

// 连通性测试：上游 401 → ok:false 与状态码
it('渠道连通性测试：上游 401 返回 ok:false', async () => {
  const cookie = await login()
  const created = (await (await req('/admin/api/channels', cookie, 'POST', channelBody)).json()) as { id: number }
  const stub = stubFetch([
    (url) => (url.pathname === '/v1/chat/completions' ? new Response('{"error":{"message":"bad key"}}', { status: 401 }) : null),
  ])
  try {
    const body = (await (await req(`/admin/api/channels/${created.id}/test`, cookie, 'POST')).json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.status).toBe(401)
    expect(String(body.error)).toContain('bad key')
  } finally {
    stub.restore()
  }
})

// —— 拉取上游模型列表 ——

it('fetch-models：openai 渠道，纯域名补 /v1/models 并带 Bearer 头', async () => {
  const cookie = await login()
  const stub = stubFetch([
    (url) =>
      url.pathname === '/v1/models'
        ? new Response(JSON.stringify({ object: 'list', data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm2' }] }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const res = await req('/admin/api/channels/fetch-models', cookie, 'POST', {
    type: 'openai',
    base_url: 'https://up.example.com',
    api_key: 'upk-9',
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; models: string[] }
  expect(body.ok).toBe(true)
  expect(body.models).toEqual(['m1', 'm2']) // 去重排序
  expect(stub.calls[0].url).toBe('https://up.example.com/v1/models?limit=100')
  expect((stub.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe('Bearer upk-9')
})

it('fetch-models：带路径的 base_url 只拼 /models；anthropic 用 x-api-key 且分页聚合', async () => {
  const cookie = await login()
  let page = 0
  const stub = stubFetch([
    (url) => {
      if (url.hostname !== 'zhipu.example.com' || url.pathname !== '/api/paas/v4/models') return null
      page++
      return page === 1
        ? new Response(JSON.stringify({ data: [{ id: 'glm-a' }, { id: 'glm-b' }], has_more: true, last_id: 'glm-b' }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: 'glm-c' }], has_more: false }), { status: 200 })
    },
  ])
  stubs.push(stub)
  const res = await req('/admin/api/channels/fetch-models', cookie, 'POST', {
    type: 'anthropic',
    base_url: 'https://zhipu.example.com/api/paas/v4',
    api_key: 'zk-1',
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; models: string[] }
  expect(body.models).toEqual(['glm-a', 'glm-b', 'glm-c'])
  expect(stub.calls).toHaveLength(2)
  const h1 = stub.calls[0].init?.headers as Record<string, string>
  expect(h1['x-api-key']).toBe('zk-1')
  expect(stub.calls[0].url).toContain('limit=100')
  expect(stub.calls[1].url).toContain('after_id=glm-b')
})

it('fetch-models：上游失败返回 ok:false；未登录 401', async () => {
  const cookie = await login()
  const stub = stubFetch([(url) => new Response('nope', { status: 403 })])
  stubs.push(stub)
  const bad = await req('/admin/api/channels/fetch-models', cookie, 'POST', {
    type: 'openai',
    base_url: 'https://up.example.com',
    api_key: 'k',
  })
  const badBody = (await bad.json()) as { ok: boolean; status: number }
  expect(badBody.ok).toBe(false)
  expect(badBody.status).toBe(403)
  expect((await SELF.fetch(`${base}/admin/api/channels/fetch-models`, { method: 'POST' })).status).toBe(401)
})
