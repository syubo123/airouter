// OpenAI Chat ↔ OpenAI Responses 双向转换器（同家族两端点间的互转）
import { encodeSSE, parseSSE } from './sse'
import { sseStreamFromGenerator, tryParseJson, type ConvPair } from './types'

/** Responses 输入项（message / function_call / function_call_output） */
interface RItem {
  /** 项类型 */
  type: string
  /** 角色（message 项） */
  role?: string
  /** 消息内容（message 项，字符串或部件数组） */
  content?: unknown
  /** 调用 ID（function_call / function_call_output） */
  call_id?: string
  /** 工具名（function_call） */
  name?: string
  /** 工具参数 JSON 字符串（function_call） */
  arguments?: string
  /** 工具输出（function_call_output） */
  output?: string
  /** 项 id（msg_/fc_） */
  id?: string
}

/** Responses 内容部件（input_text / input_image / output_text） */
interface RPart {
  /** 部件类型 */
  type: string
  /** 文本 */
  text?: string
  /** 图片地址（input_image） */
  image_url?: string
}

// ==================== 请求转换 ====================

/**
 * OpenAI Chat 请求 → Responses 请求
 */
function chatReqToResponses(body: any, model: string): any {
  const items: RItem[] = []
  const systemTexts: string[] = []
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemTexts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      items.push({ type: 'function_call_output', call_id: String(m.tool_call_id ?? ''), output: text })
      continue
    }
    if (m.role === 'assistant') {
      const parts: RPart[] = []
      if (typeof m.content === 'string' && m.content) parts.push({ type: 'output_text', text: m.content })
      else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<Record<string, any>>) {
          if (p.type === 'text') parts.push({ type: 'output_text', text: String(p.text ?? '') })
        }
      }
      if (parts.length) items.push({ type: 'message', role: 'assistant', content: parts })
      for (const tc of (m.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
        items.push({ type: 'function_call', call_id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), arguments: String(tc.function?.arguments ?? '{}') })
      }
      continue
    }
    // user
    if (typeof m.content === 'string') {
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] })
    } else if (Array.isArray(m.content)) {
      const parts: RPart[] = []
      for (const p of m.content as Array<Record<string, any>>) {
        if (p.type === 'text') parts.push({ type: 'input_text', text: String(p.text ?? '') })
        else if (p.type === 'image_url' && p.image_url?.url) parts.push({ type: 'input_image', image_url: p.image_url.url })
      }
      items.push({ type: 'message', role: 'user', content: parts })
    }
  }
  const out: any = { model, input: items }
  if (systemTexts.length) out.instructions = systemTexts.join('\n\n')
  if (typeof body.max_tokens === 'number') out.max_output_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      name: String(t.function?.name ?? ''),
      description: t.function?.description ?? '',
      parameters: t.function?.parameters ?? { type: 'object' },
    }))
  }
  if (body.stream) out.stream = true
  return out
}

/**
 * Responses 请求 → OpenAI Chat 请求
 */
function responsesReqToChat(body: any, model: string): any {
  const messages: Array<Record<string, any>> = []
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }
  const input: RItem[] = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }] : (body.input ?? [])
  for (const item of input) {
    // 无 type 字段但有 role 的项按 EasyInputMessage 处理（OpenAI 最常用形态）
    const isMessage = item.type === 'message' || (item.type === undefined && typeof item.role === 'string')
    if (isMessage) {
      if (item.role === 'system' || item.role === 'developer') {
        const text = typeof item.content === 'string' ? item.content : (item.content as RPart[] | undefined)?.map((p) => p.text ?? '').join('') ?? ''
        if (text) messages.push({ role: 'system', content: text })
        continue
      }
      if (item.role === 'assistant') {
        // content 可能是字符串（EasyInputMessage）或 output_text 部件数组
        const text = typeof item.content === 'string' ? item.content : ((item.content as RPart[] | undefined) ?? []).map((p) => p.text ?? '').join('')
        messages.push({ role: 'assistant', content: text || null })
      } else {
        if (typeof item.content === 'string') {
          messages.push({ role: 'user', content: item.content })
        } else {
          const parts: Array<Record<string, any>> = []
          for (const p of (item.content as RPart[] | undefined) ?? []) {
            if (p.type === 'input_text' || p.type === 'output_text') parts.push({ type: 'text', text: p.text ?? '' })
            else if (p.type === 'input_image' && p.image_url) parts.push({ type: 'image_url', image_url: { url: p.image_url } })
          }
          // 纯文本时折叠为字符串（对纯 chat 上游最友好）
          if (parts.every((p) => p.type === 'text')) {
            messages.push({ role: 'user', content: parts.map((p) => p.text).join('') })
          } else {
            messages.push({ role: 'user', content: parts })
          }
        }
      }
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: String(item.call_id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } }],
      })
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: String(item.output ?? '') })
    }
  }
  const out: any = { model, messages }
  if (typeof body.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: { name: String(t.name ?? ''), description: t.description ?? '', parameters: t.parameters ?? { type: 'object' } },
    }))
  }
  if (body.stream) out.stream = true
  return out
}

// ==================== 非流式响应转换 ====================

/**
 * 从 Responses 输出项提取文本与函数调用
 * @param output Responses output 数组
 */
function extractR(output: RItem[]): { text: string; toolCalls: Array<Record<string, any>> } {
  const texts: string[] = []
  const toolCalls: Array<Record<string, any>> = []
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const p of item.content as RPart[]) if (p.type === 'output_text' && p.text) texts.push(p.text)
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: String(item.call_id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } })
    }
  }
  return { text: texts.join('\n'), toolCalls }
}

/**
 * Responses 响应 → Chat completion 响应
 */
function responsesRespToChat(up: any, model: string): any {
  const { text, toolCalls } = extractR(up.output ?? [])
  const message: Record<string, any> = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: `chatcmpl-${String(up.id ?? '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: up.usage?.input_tokens ?? 0, completion_tokens: up.usage?.output_tokens ?? 0, total_tokens: up.usage?.total_tokens ?? (up.usage?.input_tokens ?? 0) + (up.usage?.output_tokens ?? 0) },
  }
}

/**
 * Chat completion 响应 → Responses 响应（id 由网关状态层改写）
 */
function chatRespToResponses(up: any, model: string): any {
  const choice = up.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const output: RItem[] = []
  if (typeof msg.content === 'string' && msg.content) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
  }
  for (const tc of (msg.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
    output.push({ type: 'function_call', call_id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), arguments: String(tc.function?.arguments ?? '{}') })
  }
  return {
    id: String(up.id ?? ''),
    object: 'response',
    status: 'completed',
    model,
    output,
    usage: { input_tokens: up.usage?.prompt_tokens ?? 0, output_tokens: up.usage?.completion_tokens ?? 0, total_tokens: up.usage?.total_tokens ?? 0 },
  }
}

// ==================== 流式转换 ====================

/**
 * Responses SSE 流 → Chat chunks 流
 */
async function* responsesStreamToChat(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let id = 'chatcmpl-unknown'
  let roleSent = false
  let inputTokens = 0
  let outputTokens = 0
  let toolIdx = 0
  let finishReason: string | undefined
  let closed = false
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: any, finish: string | null = null, usage?: any): string => {
    const obj: any = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] }
    if (usage) obj.usage = usage
    return encodeSSE({ data: JSON.stringify(obj) })
  }
  const ensureRole = function* (): Generator<string> {
    if (!roleSent) {
      roleSent = true
      yield chunk({ role: 'assistant', content: '' })
    }
  }

  for await (const ev of parseSSE(upstream)) {
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (d.type === 'response.created') {
      id = `chatcmpl-${String(d.response?.id ?? 'unknown')}`
      inputTokens = d.response?.usage?.input_tokens ?? 0
      yield* ensureRole()
    } else if (d.type === 'response.output_item.added') {
      yield* ensureRole()
      const item = d.item ?? {}
      if (item.type === 'function_call') {
        const t = toolIdx++
        yield chunk({ tool_calls: [{ index: t, id: String(item.call_id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: '' } }] })
      }
    } else if (d.type === 'response.output_text.delta') {
      yield* ensureRole()
      yield chunk({ content: String(d.delta ?? '') })
    } else if (d.type === 'response.function_call_arguments.delta') {
      yield chunk({ tool_calls: [{ index: Math.max(toolIdx - 1, 0), function: { arguments: String(d.delta ?? '') } }] })
    } else if (d.type === 'response.completed' || d.type === 'response.failed' || d.type === 'response.incomplete') {
      if (d.response?.usage?.input_tokens !== undefined) inputTokens = d.response.usage.input_tokens
      outputTokens = d.response?.usage?.output_tokens ?? outputTokens
      finishReason = d.type === 'response.completed' ? (toolIdx > 0 ? 'tool_calls' : 'stop') : d.type === 'response.incomplete' ? 'length' : 'content_filter'
      yield chunk({}, finishReason, { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens })
      yield encodeSSE({ data: '[DONE]' })
      closed = true
    }
  }
  if (!closed) {
    yield* ensureRole()
    yield chunk({}, finishReason ?? 'stop', { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens })
    yield encodeSSE({ data: '[DONE]' })
  }
}

/**
 * Chat chunks 流 → Responses SSE 流
 */
async function* chatStreamToResponses(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let started = false
  let currentItem: Record<string, any> | null = null
  let itemIndex = 0
  let finishReason: string | undefined
  /** 已完成项快照（completed 事件的 output 用） */
  const doneItems: Array<Record<string, any>> = []
  /** chat 收尾块携带的 usage（部分中转会带） */
  let usage: Record<string, number> | undefined
  const q: string[] = []
  const push = (obj: any): void => {
    q.push(encodeSSE({ event: obj.type, data: JSON.stringify(obj) }))
  }
  /** 响应对象骨架；id 用 resp_ 前缀占位（网关状态层会改写为自己的 id） */
  const responseObject = (status: string): Record<string, any> => ({ id: 'resp_pending', object: 'response', status, model, output: [] })

  for await (const ev of parseSSE(upstream)) {
    if (ev.data === '[DONE]') break
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (!started) {
      started = true
      push({ type: 'response.created', response: responseObject('in_progress') })
    }
    const choice = d.choices?.[0]
    const delta = choice?.delta ?? {}
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!currentItem || currentItem.type !== 'message') {
        if (currentItem) {
          push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
          doneItems.push(currentItem)
          itemIndex++
        }
        currentItem = { type: 'message', id: `msg_${itemIndex}`, role: 'assistant', content: [] }
        push({ type: 'response.output_item.added', output_index: itemIndex, item: currentItem })
      }
      // 累积文本（done item 保留完整内容）
      const prev = String(currentItem.content?.[0]?.text ?? '')
      currentItem.content = [{ type: 'output_text', text: prev + delta.content }]
      push({ type: 'response.output_text.delta', output_index: itemIndex, delta: delta.content })
    }
    for (const tc of (delta.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
      if (tc.id || tc.function?.name) {
        if (currentItem) {
          push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
          doneItems.push(currentItem)
          itemIndex++
        }
        currentItem = { type: 'function_call', id: `fc_${itemIndex}`, call_id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), arguments: '' }
        push({ type: 'response.output_item.added', output_index: itemIndex, item: currentItem })
      }
      if (tc.function?.arguments && currentItem) {
        // 累积参数片段
        currentItem.arguments = String(currentItem.arguments ?? '') + tc.function.arguments
        push({ type: 'response.function_call_arguments.delta', output_index: itemIndex, delta: tc.function.arguments })
      }
    }
    if (d.usage) usage = d.usage
    if (choice?.finish_reason) finishReason = choice.finish_reason
    yield* q.splice(0)
  }
  if (currentItem) {
    push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
    doneItems.push(currentItem)
    itemIndex++
    currentItem = null
  }
  const resp = responseObject('completed')
  resp.output = doneItems
  resp.usage = usage
    ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 }
    : { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  push({ type: 'response.completed', response: resp })
  yield* q.splice(0)
}

// ==================== 导出的两对转换器 ====================

/** OpenAI Chat 客户端 → Responses 上游 */
export const chatToResponses: ConvPair = {
  convertRequest: chatReqToResponses,
  convertResponse: responsesRespToChat,
  convertStream: (upstream, model) => sseStreamFromGenerator(responsesStreamToChat(upstream, model)),
}

/** OpenAI Responses 客户端 → Chat 上游 */
export const responsesToChat: ConvPair = {
  convertRequest: responsesReqToChat,
  convertResponse: chatRespToResponses,
  convertStream: (upstream, model) => sseStreamFromGenerator(chatStreamToResponses(upstream, model)),
}
