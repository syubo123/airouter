// Task 5：网关基础（key 鉴权、模型路由、/v1/models）测试
import { SELF, env } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { resetDb } from './db'
import { selectChannels } from '../src/worker/gateway/router'

// 每个测试前重置数据库
beforeEach(resetDb)

/** 测试用 Worker 地址 */
const base = 'https://example.com'

/** 直连 DB 插入渠道 */
async function insertChannel(name: string, type: 'openai' | 'anthropic', models: string[], priority: number, enabled = 1): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO channels (name, type, base_url, api_key, models, model_mapping, priority, supports_responses, enabled) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(name, type, 'https://up.example.com', 'upk', JSON.stringify(models), '{}', priority, 0, enabled)
    .run()
}

/** 直连 DB 插入 key 并返回密钥 */
async function insertKey(name: string, enabled = 1): Promise<string> {
  const k = `sk-test-${name}`
  await env.DB.prepare('INSERT INTO api_keys (name, key, enabled) VALUES (?,?,?)').bind(name, k, enabled).run()
  return k
}

// 无 key：401 + OpenAI 风格错误体
it('无 key 访问 /v1/models 返回 401 与 OpenAI 风格错误体', async () => {
  const res = await SELF.fetch(`${base}/v1/models`)
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: { message: '无效的 API key', type: 'invalid_request_error' } })
})

// 错 key 与禁用 key：401
it('错误 key 与禁用 key 返回 401', async () => {
  await insertKey('live', 1)
  await insertKey('dead', 0)
  const wrong = await SELF.fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer sk-nope' } })
  expect(wrong.status).toBe(401)
  const disabled = await SELF.fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer sk-test-dead' } })
  expect(disabled.status).toBe(401)
})

// 有效 key：Bearer 与 x-api-key 两种传法都能列出启用渠道的模型并集
it('有效 key 列出模型并集（Bearer 与 x-api-key 两种传法）', async () => {
  const key = await insertKey('live', 1)
  await insertChannel('a', 'openai', ['gpt-4o', 'gpt-4o-mini'], 0)
  await insertChannel('b', 'anthropic', ['gpt-4o', 'claude-3-5'], 1)
  await insertChannel('off', 'openai', ['hidden-model'], 0, 0)

  const res = await SELF.fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> }
  expect(body.object).toBe('list')
  expect(body.data.map((d) => d.id).sort()).toEqual(['claude-3-5', 'gpt-4o', 'gpt-4o-mini'])
  expect(body.data.every((d) => d.object === 'model')).toBe(true)

  const res2 = await SELF.fetch(`${base}/v1/models`, { headers: { 'x-api-key': key } })
  expect(res2.status).toBe(200)

  // 调用后 last_used_at 已更新
  const row = await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE name = ?').bind('live').first<{ last_used_at: string | null }>()
  expect(row!.last_used_at).not.toBeNull()
})

// selectChannels：启用 + 模型匹配过滤，按 priority 升序（同优先级按 id）
it('selectChannels 按启用状态、模型匹配过滤并按优先级排序', async () => {
  await insertChannel('c2', 'openai', ['m1'], 5)
  await insertChannel('c1', 'openai', ['m1'], 1)
  await insertChannel('off', 'openai', ['m1'], 0, 0)
  await insertChannel('other', 'anthropic', ['m2'], 0)

  const got = await selectChannels(env.DB, 'm1')
  expect(got.map((ch) => ch.name)).toEqual(['c1', 'c2'])
  expect(got[0].models).toEqual(['m1'])
  expect(got[0].model_mapping).toEqual({})
  expect(got[0].enabled).toBe(true)
})
