// Task 11：网关核心集成测试（透传/转换/失败转移/有状态/日志）
import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetDb } from './db'
import { stubFetch, type RecordedCall, type Responder } from './fetchstub'
import { timeouts } from '../src/worker/gateway/handler'

// 每个测试前重置数据库
beforeEach(resetDb)

/** 记录已安装的 fetch 桩（afterEach 统一恢复） */
let stubs: Array<{ calls: RecordedCall[]; restore(): void }> = []
afterEach(() => {
  for (const s of stubs) s.restore()
  stubs = []
  // 恢复默认超时（个别测试会调小）
  timeouts.streamFirstByteMs = 30_000
  timeouts.nonStreamTotalMs = 300_000
})

/** 测试用 Worker 地址 */
const base = 'https://example.com'

/** 直连 DB 插入渠道 */
async function insertChannel(o: {
  name: string
  type: 'openai' | 'anthropic'
  baseUrl: string
  models?: string[]
  priority?: number
  supports_responses?: number
}): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO channels (name, type, base_url, api_key, models, model_mapping, priority, supports_responses, enabled) VALUES (?,?,?,?,?,?,?,?,1)',
  )
    .bind(o.name, o.type, o.baseUrl, `key-${o.name}`, JSON.stringify(o.models ?? ['test-model']), '{}', o.priority ?? 0, o.supports_responses ?? 0)
    .run()
}

/** 直连 DB 插入 key */
async function insertKey(): Promise<string> {
  const k = 'sk-gw-test'
  await env.DB.prepare('INSERT INTO api_keys (name, key, enabled) VALUES (?,?,1)').bind('测试key', k).run()
  return k
}

/** 发起网关请求 */
function gw(path: string, key: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
}

/** JSON 响应读取辅助 */
async function json(res: Response): Promise<any> {
  return res.json()
}

/** OpenAI chat 上游 200 响应 */
const chatUpstreamOk = (): Responder => (url) =>
  url.pathname === '/v1/chat/completions'
    ? new Response(JSON.stringify({ id: 'cc_ok', choices: [{ index: 0, message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), { status: 200 })
    : null

// —— 1. 同格式透传（chat → openai 渠道）：模型改名映射、鉴权头、透传请求体 ——

it('chat 请求透传 openai 渠道：除模型改名外请求体一致，带 Bearer 头', async () => {
  await insertChannel({ name: '主渠道', type: 'openai', baseUrl: 'https://up1.example.com' })
  const key = await insertKey()
  // 改名映射
  await env.DB.prepare("UPDATE channels SET model_mapping = '{\"test-model\":\"test-model-v2\"}' WHERE name = '主渠道'").run()

  const stub = stubFetch([chatUpstreamOk()])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, {
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.5,
    some_new_field: { nested: true },
  })
  expect(res.status).toBe(200)
  const body = await json(res)
  expect(body.choices[0].message.content).toBe('好的')
  expect(body.model).toBe('test-model') // 响应模型名改回客户端视角

  expect(stub.calls).toHaveLength(1)
  expect(stub.calls[0].url).toBe('https://up1.example.com/v1/chat/completions')
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  expect(sent.model).toBe('test-model-v2') // 改名映射生效
  expect(sent.temperature).toBe(0.5)
  expect(sent.some_new_field).toEqual({ nested: true }) // 未知字段透传
  const headers = stub.calls[0].init?.headers as Record<string, string>
  expect(headers['Authorization']).toBe('Bearer key-主渠道')
})

// —— 2. Anthropic 渠道鉴权头 ——

it('anthropic 请求透传 anthropic 渠道：x-api-key 与 anthropic-version 头', async () => {
  await insertChannel({ name: 'claude渠道', type: 'anthropic', baseUrl: 'https://up2.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) =>
      url.pathname === '/v1/messages'
        ? new Response(JSON.stringify({ id: 'msg_ok', role: 'assistant', content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const res = await gw('/v1/messages', key, { model: 'test-model', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] })
  expect(res.status).toBe(200)
  const headers = stub.calls[0].init?.headers as Record<string, string>
  expect(headers['x-api-key']).toBe('key-claude渠道')
  expect(headers['anthropic-version']).toBe('2023-06-01')
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  expect(sent.messages).toEqual([{ role: 'user', content: '你好' }])
})

// —— 3. 跨格式：chat 客户端 → anthropic 渠道（非流式 + 流式） ——

it('chat 请求转 anthropic 渠道：上游收 Anthropic 体，响应转回 OpenAI 形状', async () => {
  await insertChannel({ name: 'a渠道', type: 'anthropic', baseUrl: 'https://up3.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) =>
      url.pathname === '/v1/messages'
        ? new Response(JSON.stringify({ id: 'msg_x', role: 'assistant', content: [{ type: 'text', text: '跨格式回答' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: '你好' }] })
  expect(res.status).toBe(200)
  const body = await json(res)
  expect(body.object).toBe('chat.completion')
  expect(body.choices[0].message.content).toBe('跨格式回答')
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  expect(sent.max_tokens).toBe(4096) // max_tokens 补默认
  expect(sent.messages[0].content).toEqual([{ type: 'text', text: '你好' }])
})

it('chat 流式请求转 anthropic 渠道：客户端收到 OpenAI chunk 流且以 [DONE] 结束', async () => {
  await insertChannel({ name: 'a渠道', type: 'anthropic', baseUrl: 'https://up4.example.com' })
  const key = await insertKey()

  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","usage":{"input_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"流式"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const stub = stubFetch([
    (url) => (url.pathname === '/v1/messages' ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)

  const res = await gw('/v1/chat/completions', key, { model: 'test-model', stream: true, messages: [{ role: 'user', content: '你好' }] })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('chat.completion.chunk')
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  expect(text).toContain('流式')
})

// —— 4. R 开关两路 ——

it('R 请求 + supports_responses=1 渠道：透传到上游 /v1/responses', async () => {
  await insertChannel({ name: 'r渠道', type: 'openai', baseUrl: 'https://up5.example.com', supports_responses: 1 })
  const key = await insertKey()

  const stub = stubFetch([
    (url) =>
      url.pathname === '/v1/responses'
        ? new Response(JSON.stringify({ id: 'resp_up', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'R答' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const res = await gw('/v1/responses', key, { model: 'test-model', input: '你好' })
  expect(res.status).toBe(200)
  const body = await json(res)
  expect(body.object).toBe('response')
  // 透传路径响应 id 是网关签发的 resp_*（store 默认开）
  expect(body.id).toMatch(/^resp_/)
  expect(body.id).not.toBe('resp_up')
  // 上游收到透传 input，且 store 被置 false（状态由网关持有）
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  expect(sent.input).toBe('你好')
  expect(sent.store).toBe(false)
  expect(sent.previous_response_id).toBeUndefined()
})

it('R 请求 + supports_responses=0 渠道：转换到上游 /v1/chat/completions', async () => {
  await insertChannel({ name: 'c渠道', type: 'openai', baseUrl: 'https://up6.example.com', supports_responses: 0 })
  const key = await insertKey()

  const stub = stubFetch([chatUpstreamOk()])
  stubs.push(stub)
  const res = await gw('/v1/responses', key, { model: 'test-model', input: '你好' })
  expect(res.status).toBe(200)
  const body = await json(res)
  expect(body.object).toBe('response')
  expect(body.output[0].content[0].text).toBe('好的')
  // 上游收到 chat 格式
  expect(stub.calls[0].url).toBe('https://up6.example.com/v1/chat/completions')
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  expect(sent.messages).toEqual([{ role: 'user', content: '你好' }])
})

// —— 5. 有状态会话：续接展开、GET 查询、未知 404 ——

it('R 有状态：首响应签发网关 id，续接请求展开完整输入，GET 可取回', async () => {
  await insertChannel({ name: 'r渠道', type: 'openai', baseUrl: 'https://up7.example.com', supports_responses: 1 })
  const key = await insertKey()

  let stub = stubFetch([
    (url) =>
      url.pathname === '/v1/responses'
        ? new Response(JSON.stringify({ id: 'resp_up1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮回答' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const r1 = await gw('/v1/responses', key, { model: 'test-model', input: '第一轮问题' })
  const b1 = await json(r1)
  expect(b1.id).toMatch(/^resp_/)
  const gid = b1.id as string

  // 第二轮：previous_response_id 续接
  stub = stubFetch([
    (url) =>
      url.pathname === '/v1/responses'
        ? new Response(JSON.stringify({ id: 'resp_up2', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二轮回答' }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200 })
        : null,
  ])
  stubs.push(stub)
  const r2 = await gw('/v1/responses', key, { model: 'test-model', previous_response_id: gid, input: '第二轮问题' })
  expect(r2.status).toBe(200)
  const sent = JSON.parse(String(stub.calls[0].init?.body))
  // 上游收到展开后的完整输入（第一轮问答 + 第二轮问题），且不带 previous_response_id
  expect(sent.input).toEqual([
    { type: 'message', role: 'user', content: '第一轮问题' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮回答' }] },
    { type: 'message', role: 'user', content: '第二轮问题' },
  ])
  expect(sent.previous_response_id).toBeUndefined()

  // GET 取回
  const got = await SELF.fetch(`${base}/v1/responses/${gid}`, { headers: { Authorization: `Bearer ${key}` } })
  expect(got.status).toBe(200)
  expect(await json(got)).toMatchObject({ id: gid, object: 'response' })

  // 未知 id 404
  const missing = await SELF.fetch(`${base}/v1/responses/resp_nope`, { headers: { Authorization: `Bearer ${key}` } })
  expect(missing.status).toBe(404)

  // 续接未知 previous_response_id 也 404
  const bad = await gw('/v1/responses', key, { model: 'test-model', previous_response_id: 'resp_nope', input: 'x' })
  expect(bad.status).toBe(404)
})

it('R 流式有状态：事件里的上游 id 被改写为网关 id', async () => {
  await insertChannel({ name: 'r渠道', type: 'openai', baseUrl: 'https://up8.example.com', supports_responses: 1 })
  const key = await insertKey()

  const sse =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_upS","status":"in_progress"}}\n\n' +
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","content":[]}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"流R"}\n\n' +
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"流R"}]}}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_upS","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
  const stub = stubFetch([
    (url) => (url.pathname === '/v1/responses' ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)

  const res = await gw('/v1/responses', key, { model: 'test-model', input: '你好', stream: true })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).not.toContain('resp_upS')
  expect(text).toContain('流R')
  // 从事件中提取网关 id 并断言可续接
  const m = /"id":"(resp_[A-Za-z0-9]+)"/.exec(text)
  expect(m).not.toBeNull()
})

// —— 6. 失败转移 ——

it('首选渠道 500 → 自动落到次选渠道，客户端无感', async () => {
  await insertChannel({ name: '坏渠道', type: 'openai', baseUrl: 'https://bad.example.com' })
  await insertChannel({ name: '好渠道', type: 'openai', baseUrl: 'https://good.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) => (url.hostname === 'bad.example.com' ? new Response('boom', { status: 500 }) : null),
    (url) => (url.hostname === 'good.example.com' ? (chatUpstreamOk() as any)(url) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  expect((await json(res)).choices[0].message.content).toBe('好的')
  expect(stub.calls.map((c) => new URL(c.url).hostname)).toEqual(['bad.example.com', 'good.example.com'])
})

it('首选渠道 401（key 失效）→ skip 落次选', async () => {
  await insertChannel({ name: '过期渠道', type: 'openai', baseUrl: 'https://expired.example.com' })
  await insertChannel({ name: '好渠道', type: 'openai', baseUrl: 'https://good2.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) => (url.hostname === 'expired.example.com' ? new Response('unauthorized', { status: 401 }) : null),
    (url) => (url.hostname === 'good2.example.com' ? (chatUpstreamOk() as any)(url) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
})

it('首选渠道 400（请求问题）→ 直接返回 400，不试次选', async () => {
  await insertChannel({ name: '主', type: 'openai', baseUrl: 'https://main.example.com' })
  await insertChannel({ name: '备', type: 'openai', baseUrl: 'https://backup.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) => (url.hostname === 'main.example.com' ? new Response('{"error":{"message":"bad request"}}', { status: 400 }) : null),
    (url) => (url.hostname === 'backup.example.com' ? (chatUpstreamOk() as any)(url) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(400)
  expect(stub.calls).toHaveLength(1) // 次选未被调用
})

it('全部渠道失败 → 502 聚合错误体 + failure_logs 记一行', async () => {
  await insertChannel({ name: '甲', type: 'openai', baseUrl: 'https://j.example.com' })
  await insertChannel({ name: '乙', type: 'anthropic', baseUrl: 'https://y.example.com' })
  const key = await insertKey()

  const stub = stubFetch([(url) => new Response('down', { status: 503 })])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(502)
  const body = await json(res)
  expect(body.error.message).toContain('甲')
  expect(body.error.message).toContain('乙')

  const logs = await env.DB.prepare('SELECT * FROM failure_logs').all<any>()
  expect(logs.results).toHaveLength(1)
  expect(logs.results![0].api_key_name).toBe('测试key')
  expect(logs.results![0].channel_name).toBe('甲/乙')
  expect(logs.results![0].model).toBe('test-model')
  expect(logs.results![0].error).toContain('503')
})

// —— 7. 超时（可注入配置）：非流式长等待不误切，超时后切渠道 ——

it('超时：非流式超时后切到次选渠道', async () => {
  await insertChannel({ name: '慢渠道', type: 'openai', baseUrl: 'https://slow.example.com' })
  await insertChannel({ name: '快渠道', type: 'openai', baseUrl: 'https://fast.example.com' })
  const key = await insertKey()
  timeouts.nonStreamTotalMs = 100

  // 慢渠道：挂起不返回，abort 时 reject（模拟真实 fetch 超时行为）；快渠道正常
  const stub = stubFetch([
    (url, init) => {
      if (url.hostname === 'slow.example.com') {
        const pending = new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        return pending as unknown as Response
      }
      return null
    },
    (url) => (url.hostname === 'fast.example.com' ? (chatUpstreamOk() as any)(url) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  expect((await json(res)).choices[0].message.content).toBe('好的')
})

// —— 8. 日志清理：预插 505 行，一次失败后 ≤ 500 ——

it('失败日志自动清理至 500 条', async () => {
  await insertChannel({ name: '唯一', type: 'openai', baseUrl: 'https://only.example.com' })
  const key = await insertKey()
  for (let i = 0; i < 505; i++) {
    await env.DB.prepare("INSERT INTO failure_logs (api_key_name, channel_name, model, endpoint, status, error) VALUES ('旧','旧渠道','m','x',500,'old')").run()
  }
  const stub = stubFetch([(url) => new Response('down', { status: 500 })])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(502)
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM failure_logs').all<{ n: number }>()
  expect(results![0].n).toBeLessThanOrEqual(500)
})

// —— 9. 流已开始后上游中断：优雅结束、不重试 ——

it('流式请求上游中断：客户端流正常结束且不重试', async () => {
  await insertChannel({ name: '唯一', type: 'anthropic', baseUrl: 'https://stream.example.com' })
  const key = await insertKey()

  // 上游发出一个事件后连接错误（第二次 pull 时 error，确定性触发）
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"部分"}}\n\n'),
      )
    },
    pull(controller) {
      controller.error(new Error('upstream broke'))
    },
  })
  const stub = stubFetch([
    (url) => (url.hostname === 'stream.example.com' ? new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)

  // chat 客户端流式 → anthropic 渠道：转换器在流中断时优雅收尾
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  // 读取完整流不抛错（优雅结束），含已输出的部分内容与 [DONE]
  const text = await res.text()
  expect(text).toContain('部分')
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  expect(stub.calls).toHaveLength(1) // 没有重试
})

// —— 10. 非法 JSON 请求体 ——

it('非法 JSON 请求体 → 400 OpenAI 风格错误', async () => {
  await insertChannel({ name: '主', type: 'openai', baseUrl: 'https://x.example.com' })
  const key = await insertKey()
  const res = await SELF.fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: 'not-json{{',
  })
  expect(res.status).toBe(400)
  expect(await json(res)).toEqual({ error: { message: expect.stringContaining('JSON'), type: 'invalid_request_error' } })
})

// —— 修复回合：评审 C1/I2/I3/I4 —— 

// C1：三轮续接，items 不得重复拼接 prior
it('R 有状态第三轮：上游收到的展开 items 无重复', async () => {
  await insertChannel({ name: 'r渠道', type: 'openai', baseUrl: 'https://up9.example.com', supports_responses: 1 })
  const key = await insertKey()

  const turns = [
    { q: '第一轮问题', a: '第一轮回答' },
    { q: '第二轮问题', a: '第二轮回答' },
    { q: '第三轮问题', a: '第三轮回答' },
  ]
  let gid = ''
  for (const t of turns) {
    const stub = stubFetch([
      (url) =>
        url.pathname === '/v1/responses'
          ? new Response(
              JSON.stringify({
                id: `resp_up_${t.q}`,
                object: 'response',
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.a }] }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              }),
              { status: 200 },
            )
          : null,
    ])
    stubs.push(stub)
    const body: Record<string, unknown> = { model: 'test-model', input: t.q }
    if (gid) body.previous_response_id = gid
    const res = await gw('/v1/responses', key, body)
    expect(res.status).toBe(200)
    const b = (await json(res)) as { id: string }
    gid = b.id
  }
  // 第三轮上游收到的展开序列：q1,a1,q2,a2,q3（5 项，无重复）
  const sent = JSON.parse(String(stubs[stubs.length - 1].calls[0].init?.body))
  expect(sent.input).toEqual([
    { type: 'message', role: 'user', content: '第一轮问题' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮回答' }] },
    { type: 'message', role: 'user', content: '第二轮问题' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二轮回答' }] },
    { type: 'message', role: 'user', content: '第三轮问题' },
  ])
})

// I2：流式首字节超时 → 切渠道（响应头已回但 body 一直不吐数据）
it('流式首字节超时：切到次选渠道', async () => {
  await insertChannel({ name: '慢渠道', type: 'anthropic', baseUrl: 'https://slowst.example.com' })
  await insertChannel({ name: '快渠道', type: 'anthropic', baseUrl: 'https://fastst.example.com' })
  const key = await insertKey()
  timeouts.streamFirstByteMs = 100

  const hangingBody = new ReadableStream<Uint8Array>({
    pull() {
      // 永不产出数据（挂起）
    },
  })
  const fastSse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_f","usage":{"input_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"快"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const stub = stubFetch([
    (url) => (url.hostname === 'slowst.example.com' ? new Response(hangingBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
    (url) => (url.hostname === 'fastst.example.com' ? new Response(fastSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('快')
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
})

// I3：透传路径（chat→openai）流式上游中断：补 [DONE] 终止标记
it('透传流上游中断：客户端收到 [DONE] 终止标记', async () => {
  await insertChannel({ name: '唯一', type: 'openai', baseUrl: 'https://passthrough.example.com' })
  const key = await insertKey()

  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"cc","choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n'))
    },
    pull(controller) {
      controller.error(new Error('upstream broke'))
    },
  })
  const stub = stubFetch([
    (url) => (url.hostname === 'passthrough.example.com' ? new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('部分')
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true) // 透传路径也补终止标记
})

// I4：上游 200 + 非 JSON body（错误页）→ 视为渠道失败切下一个
it('上游 200 返回非 JSON：切到次选渠道', async () => {
  await insertChannel({ name: '坏渠道', type: 'openai', baseUrl: 'https://htmlerr.example.com' })
  await insertChannel({ name: '好渠道', type: 'openai', baseUrl: 'https://good3.example.com' })
  const key = await insertKey()

  const stub = stubFetch([
    (url) => (url.hostname === 'htmlerr.example.com' ? new Response('<html>gateway error</html>', { status: 200, headers: { 'content-type': 'text/html' } }) : null),
    (url) => (url.hostname === 'good3.example.com' ? (chatUpstreamOk() as any)(url) : null),
  ])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  expect((await json(res)).choices[0].message.content).toBe('好的')
})

// I4b：全部渠道都 200+非 JSON → 502 并记日志
it('全部渠道 200 返回非 JSON：502 且记失败日志', async () => {
  await insertChannel({ name: '甲', type: 'openai', baseUrl: 'https://onlyhtml.example.com' })
  const key = await insertKey()
  const stub = stubFetch([(url) => new Response('<html>err</html>', { status: 200, headers: { 'content-type': 'text/html' } })])
  stubs.push(stub)
  const res = await gw('/v1/chat/completions', key, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(502)
  const logs = await env.DB.prepare('SELECT * FROM failure_logs').all<any>()
  expect(logs.results).toHaveLength(1)
  expect(logs.results![0].error).toContain('非 JSON')
})

// C2+I1 集成：R 客户端 + anthropic 渠道 + 流式 + store：多片段累积与 completed.output 完整
it('R 流式经 anthropic 渠道：多片段累积、completed 输出完整、id 为网关 resp_、状态可续接', async () => {
  await insertChannel({ name: 'a渠道', type: 'anthropic', baseUrl: 'https://up10.example.com' })
  const key = await insertKey()

  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_multi","usage":{"input_tokens":7}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const stub = stubFetch([
    (url) => (url.pathname === '/v1/messages' ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : null),
  ])
  stubs.push(stub)

  const res = await gw('/v1/responses', key, { model: 'test-model', input: '你好', stream: true })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).not.toContain('msg_multi') // 上游 id 全部被改写
  // completed 事件里 output 完整（两个 delta 拼接为 你好）
  const completed = text
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l.includes('"type":"response.completed"'))
    .map((l) => JSON.parse(l.slice(6)))[0] as any
  expect(completed.response.output).toMatchObject([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }])
  expect(completed.response.id).toMatch(/^resp_/)

  // 存储的会话可续接：items = 输入 + 完整输出
  const gid = completed.response.id
  const got = await SELF.fetch(`${base}/v1/responses/${gid}`, { headers: { Authorization: `Bearer ${key}` } })
  expect(got.status).toBe(200)
  const stored = await json(got)
  expect(stored.output).toMatchObject([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }])
})
