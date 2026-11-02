// 网关核心：透传/转换、失败转移、Responses 有状态接线、失败日志
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { keyAuth } from './keyauth'
import { selectChannels } from './router'
import { classifyStatus, errorBodyFor, invalidRequestBodyFor } from './errors'
import { pickPair, pickUpstreamPath, upstreamHeaders, type ClientFormat } from './upstream'
import { expandInput, loadResponseJson, loadState, newResponseId, rewriteResponseId, saveState } from './responses_state'
import { encodeSSE, parseSSE } from '../convert/sse'
import { bytesStreamFromGenerator, sseStreamFromGenerator, tryParseJson, type ConvPair } from '../convert/types'

/** 超时配置（模块级可注入，测试传小值） */
export const timeouts = {
  /** 流式请求等待首个数据块的超时（毫秒），超时切下一个渠道 */
  streamFirstByteMs: 30_000,
  /** 非流式请求总时长超时（毫秒，覆盖响应体读取），超时切下一个渠道 */
  nonStreamTotalMs: 300_000,
}

/** 失败日志保留条数 */
const KEEP_LOGS = 500

/**
 * 记录一条失败日志并清理旧数据
 * @param db D1 绑定
 * @param row 日志内容
 */
async function recordFailure(
  db: D1Database,
  row: { api_key_name: string; channel_name: string; model: string; endpoint: string; status: number; error: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO failure_logs (api_key_name, channel_name, model, endpoint, status, error) VALUES (?,?,?,?,?,?)')
    .bind(row.api_key_name, row.channel_name, row.model, row.endpoint, row.status, row.error.slice(0, 1000))
    .run()
  await db.prepare('DELETE FROM failure_logs WHERE id NOT IN (SELECT id FROM failure_logs ORDER BY id DESC LIMIT ?)').bind(KEEP_LOGS).run()
}

/**
 * 规范化 R 请求的 input 为 items 数组（字符串包装为 message item）
 * @param input 请求 input 字段
 */
function normalizeInputItems(input: unknown): unknown[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }]
  if (Array.isArray(input)) return input
  return []
}

/**
 * 从已读出首块的 reader 继续读取：上游中断时安静结束（由终止标记/转换器收尾）
 * @param reader 上游 body reader
 * @param firstChunk 首字节竞速已读出的块
 */
async function* restOfReader(reader: ReadableStreamDefaultReader<Uint8Array>, firstChunk?: Uint8Array): AsyncGenerator<Uint8Array> {
  if (firstChunk) yield firstChunk
  for (;;) {
    try {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    } catch {
      // 上游中断：直接结束
      return
    }
  }
}

/**
 * 透传流的终止标记兜底：上游中断（未见正常终止标记）时按客户端格式补发终止事件
 * @param stream 透传字节流
 * @param fmt 客户端格式
 */
function withTerminator(stream: ReadableStream<Uint8Array>, fmt: ClientFormat): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const gen = async function* (): AsyncGenerator<Uint8Array> {
    const dec = new TextDecoder()
    /** 累积文本（终止标记探测用） */
    let acc = ''
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      acc += dec.decode(value, { stream: true })
      yield value
    }
    // 流结束：按格式补终止标记
    if (fmt === 'openai-chat') {
      if (!acc.includes('[DONE]')) yield enc.encode('data: [DONE]\n\n')
    } else if (fmt === 'anthropic') {
      if (acc.includes('"type":"message_start"') && !acc.includes('"type":"message_stop"')) {
        yield enc.encode(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      }
    } else {
      // openai-responses 透传且未 store：补 incomplete 终止事件
      const sawTerminal =
        acc.includes('"type":"response.completed"') || acc.includes('"type":"response.failed"') || acc.includes('"type":"response.incomplete"')
      if (acc.includes('"type":"response.created"') && !sawTerminal) {
        yield enc.encode('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n')
      }
    }
  }
  return bytesStreamFromGenerator(gen())
}

/**
 * R 格式流式响应的状态包装：改写事件中的上游 id、收集输出项、
 * 中断时补 incomplete 终止事件、结束时保存会话状态
 * @param db D1 绑定
 * @param inner 已转换为 R 事件格式的客户端侧字节流
 * @param gid 网关签发的响应 ID
 * @param inputItems 本轮展开后的输入 items（已含续接的前序内容）
 * @param clientModel 客户端请求的模型名
 */
function wrapRStreamWithState(
  db: D1Database,
  inner: ReadableStream<Uint8Array>,
  gid: string,
  inputItems: unknown[],
  clientModel: string,
): ReadableStream<Uint8Array> {
  const gen = async function* (): AsyncGenerator<string> {
    /** response.completed 里的完整输出（无则为 null） */
    let finalOutput: unknown[] | null = null
    /** 从 output_item.done 收集的输出项（中断兜底） */
    const collected: unknown[] = []
    /** 是否见到终止事件（completed/failed/incomplete） */
    let sawTerminal = false
    for await (const ev of parseSSE(inner)) {
      const d = tryParseJson(ev.data)
      if (!d) {
        yield encodeSSE(ev)
        continue
      }
      const nd = rewriteResponseId(d, gid)
      if (d.type === 'response.output_item.done' && d.item) collected.push(d.item)
      if (d.type === 'response.completed' || d.type === 'response.failed' || d.type === 'response.incomplete') {
        sawTerminal = true
        if (d.type === 'response.completed') {
          finalOutput = Array.isArray(d.response?.output) ? d.response.output : collected
          if ((nd as any).response) {
            ;(nd as any).response.id = gid
            if (!(nd as any).response.model) (nd as any).response.model = clientModel
          }
        }
      }
      yield encodeSSE({ event: ev.event, data: JSON.stringify(nd) })
    }
    const output = finalOutput ?? collected
    if (!sawTerminal) {
      // 上游中断：补 incomplete 终止事件
      yield encodeSSE({
        event: 'response.incomplete',
        data: JSON.stringify({ type: 'response.incomplete', response: { id: gid, object: 'response', status: 'incomplete', model: clientModel, output } }),
      })
    }
    // 流结束（正常或中断）：保存会话状态（items = 本轮展开输入 + 输出，前序内容已含于输入）
    await saveState(db, gid, [...inputItems, ...output], JSON.stringify({ id: gid, object: 'response', status: finalOutput ? 'completed' : 'incomplete', model: clientModel, output }))
  }
  return sseStreamFromGenerator(gen())
}

/**
 * 网关主流程：解析 → （R 续接展开）→ 选渠道 → 逐个尝试（透传/转换）→ 成功回传 / 全败记日志
 * @param c 请求上下文
 * @param fmt 客户端格式
 * @param endpointPath 客户端端点路径（日志用）
 */
async function handleGateway(c: Context<AppEnv>, fmt: ClientFormat, endpointPath: string): Promise<Response> {
  const raw = await c.req.text()
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json(invalidRequestBodyFor(fmt, '请求体必须是合法 JSON'), 400)
  }
  const model = typeof body?.model === 'string' ? body.model : ''
  if (!model) return c.json(invalidRequestBodyFor(fmt, '缺少 model 字段'), 400)

  // —— R 有状态：续接展开（在选渠道之前，天然兼容失败转移）——
  if (fmt === 'openai-responses' && typeof body.previous_response_id === 'string') {
    const st = await loadState(c.env.DB, body.previous_response_id)
    if (!st) {
      return c.json(invalidRequestBodyFor(fmt, `未知的 previous_response_id: ${body.previous_response_id}`), 404)
    }
    const expanded = expandInput(body, st.items)
    body = { ...body, input: expanded.input }
    delete body.previous_response_id
  }
  // 展开后的输入 items（续接时已含前序内容，保存时不再重复拼接）
  const inputItems = fmt === 'openai-responses' ? normalizeInputItems(body.input) : []
  const wantsStore = fmt === 'openai-responses' && body.store !== false

  const channels = await selectChannels(c.env.DB, model)
  const failures: string[] = []
  let lastStatus = 0

  for (const ch of channels) {
    const upstreamModel = ch.model_mapping[model] ?? model
    const pair = pickPair(fmt, ch)
    const path = pickUpstreamPath(fmt, ch)
    const upstreamBody = pair ? pair.convertRequest(body, upstreamModel) : { ...body, model: upstreamModel }
    // R 透传路径：状态由网关持有，上游无需存储
    if (pair === null && fmt === 'openai-responses') upstreamBody.store = false

    const isStreamReq = upstreamBody.stream === true
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), isStreamReq ? timeouts.streamFirstByteMs : timeouts.nonStreamTotalMs)
    /** abort 触发的拒绝（流式首字节竞速用） */
    const abortReject = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })

    let resp: Response
    try {
      resp = await fetch(`${ch.base_url}${path}`, {
        method: 'POST',
        headers: upstreamHeaders(ch),
        body: JSON.stringify(upstreamBody),
        signal: ctrl.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const msg = (e as Error).name === 'AbortError' ? '等待上游响应超时' : `网络错误：${(e as Error).message}`
      failures.push(`${ch.name}: ${msg}`)
      lastStatus = 0
      continue
    }

    if (!resp.ok) {
      clearTimeout(timer)
      const errText = await resp.text().catch(() => '')
      lastStatus = resp.status
      const cls = classifyStatus(resp.status)
      if (cls === 'fatal') {
        // 请求本身的问题：直接返回，不试下一个渠道（也是失败调用，留痕）
        await recordFailure(c.env.DB, {
          api_key_name: c.get('keyName'),
          channel_name: ch.name,
          model,
          endpoint: `${fmt} ${endpointPath}`,
          status: resp.status,
          error: `HTTP ${resp.status} ${errText.slice(0, 300)}`,
        })
        return c.json(errorBodyFor(fmt, `上游返回 ${resp.status}：${errText.slice(0, 500)}`), resp.status as 400)
      }
      failures.push(`${ch.name}: HTTP ${resp.status} ${errText.slice(0, 200)}`)
      continue
    }

    const isStreamResp = (resp.headers.get('content-type') ?? '').includes('text/event-stream')

    // —— 流式：等首个数据块（首块超时→切渠道；首块后中断→优雅收尾）——
    if (isStreamResp && resp.body) {
      const reader = resp.body.getReader()
      let firstChunk: Uint8Array | undefined
      try {
        const r = await Promise.race([reader.read(), abortReject])
        firstChunk = r.done ? undefined : r.value
      } catch {
        clearTimeout(timer)
        failures.push(`${ch.name}: 等待首个数据块超时`)
        lastStatus = 0
        continue
      }
      clearTimeout(timer)
      const raw2 = bytesStreamFromGenerator(restOfReader(reader, firstChunk))
      if (fmt === 'openai-responses' && wantsStore) {
        const gid = newResponseId()
        const inner = pair ? pair.convertStream(raw2, model) : raw2
        return new Response(wrapRStreamWithState(c.env.DB, inner, gid, inputItems, model), { headers: { 'content-type': 'text/event-stream' } })
      }
      const out = pair ? pair.convertStream(raw2, model) : withTerminator(raw2, fmt)
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    }

    // —— 非流式：在超时覆盖下完整读取响应体 ——
    let text: string
    try {
      text = await resp.text()
    } catch {
      clearTimeout(timer)
      failures.push(`${ch.name}: 读取响应超时或中断`)
      lastStatus = resp.status
      continue
    }
    clearTimeout(timer)
    let upstreamJson: any
    try {
      upstreamJson = JSON.parse(text)
    } catch {
      // 200 + 非 JSON（中转站的 HTML 错误页等）：视为该渠道失败，切下一个
      failures.push(`${ch.name}: 上游返回了非 JSON 内容（可能是错误页）：${text.slice(0, 120)}`)
      lastStatus = resp.status
      continue
    }

    let outObj: any
    if (pair) {
      outObj = pair.convertResponse(upstreamJson, model)
    } else {
      outObj = { ...upstreamJson, model } // 透传：模型名改回客户端视角
    }
    if (fmt === 'openai-responses' && wantsStore) {
      const gid = newResponseId()
      outObj = rewriteResponseId(outObj, gid)
      outObj.id = gid
      // items = 本轮展开输入 + 输出（续接的前序内容已含于输入，不重复拼接）
      const items = [...inputItems, ...(Array.isArray(outObj.output) ? outObj.output : [])]
      await saveState(c.env.DB, gid, items, JSON.stringify(outObj))
    }
    return new Response(JSON.stringify(outObj), { headers: { 'content-type': 'application/json' } })
  }

  // —— 全部渠道失败 ——
  if (channels.length === 0) {
    failures.push(`没有启用中的渠道支持模型 ${model}`)
  }
  await recordFailure(c.env.DB, {
    api_key_name: c.get('keyName'),
    channel_name: channels.map((x) => x.name).join('/'),
    model,
    endpoint: `${fmt} ${endpointPath}`,
    status: lastStatus,
    error: failures.join(' | '),
  })
  return c.json(errorBodyFor(fmt, `所有渠道调用失败：${failures.join(' | ')}`.slice(0, 800)), 502)
}

/**
 * 在应用上注册全部网关路由（/v1/* 的对话端点与响应查询；/v1/models 由 modelsApi 单独挂载）
 * @param app Hono 应用
 */
export function registerGatewayRoutes(app: Hono<AppEnv>): void {
  app.post('/v1/chat/completions', keyAuth, (c) => handleGateway(c, 'openai-chat', '/v1/chat/completions'))
  app.post('/v1/responses', keyAuth, (c) => handleGateway(c, 'openai-responses', '/v1/responses'))
  app.post('/v1/messages', keyAuth, (c) => handleGateway(c, 'anthropic', '/v1/messages'))
  // R 有状态：查询已存储的响应
  app.get('/v1/responses/:id', keyAuth, async (c) => {
    const json = await loadResponseJson(c.env.DB, c.req.param('id'))
    if (json === null) {
      return c.json(invalidRequestBodyFor('openai-responses', '未知的 response id'), 404)
    }
    return new Response(json, { headers: { 'content-type': 'application/json' } })
  })
}
