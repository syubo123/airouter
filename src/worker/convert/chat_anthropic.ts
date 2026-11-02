// OpenAI Chat ↔ Anthropic Messages 双向转换器
import { encodeSSE, parseSSE } from './sse'
import { sseStreamFromGenerator, tryParseJson, type ConvPair } from './types'

/** 转 Anthropic 方向 max_tokens 缺省值 */
const DEFAULT_MAX_TOKENS = 4096

/** finish_reason（OpenAI）→ stop_reason（Anthropic） */
const FINISH_TO_STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
}

/** stop_reason（Anthropic）→ finish_reason（OpenAI） */
const STOP_TO_FINISH: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
}

/** OpenAI 多模态内容部件（text / image_url） */
interface OpenAiPart {
  /** 部件类型 */
  type: string
  /** 文本内容（type=text） */
  text?: string
  /** 图片定义（type=image_url） */
  image_url?: { url: string }
}

/** Anthropic 内容块（text / image / tool_use / tool_result 等） */
interface AnthropicBlock {
  /** 块类型 */
  type: string
  /** 文本内容（text 块） */
  text?: string
  /** 图片来源（image 块） */
  source?: { type: string; media_type?: string; data?: string; url?: string }
  /** 工具调用 ID（tool_use / tool_result 块） */
  id?: string
  /** 工具名（tool_use 块） */
  name?: string
  /** 工具入参（tool_use 块） */
  input?: unknown
  /** 对应的 tool_use ID（tool_result 块） */
  tool_use_id?: string
  /** 工具结果内容（tool_result 块，字符串或块数组） */
  content?: unknown
}

/**
 * OpenAI 内容部件数组转 Anthropic 块数组（图片按 data URL / http URL 分流）
 * @param parts OpenAI 内容部件
 */
function openaiPartsToBlocks(parts: OpenAiPart[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      blocks.push({ type: 'text', text: p.text ?? '' })
    } else if (p.type === 'image_url' && p.image_url?.url) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url)
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url: p.image_url.url } })
      }
    }
  }
  return blocks
}

/**
 * 提取 system 消息文本（多条以 \n\n 连接）
 * @param messages OpenAI 消息数组
 */
function extractSystem(messages: Array<Record<string, unknown>>): string | undefined {
  const texts: string[] = []
  for (const m of messages) {
    if (m.role !== 'system' && m.role !== 'developer') continue
    if (typeof m.content === 'string') texts.push(m.content)
    else if (Array.isArray(m.content)) {
      texts.push((m.content as OpenAiPart[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join(''))
    }
  }
  return texts.length ? texts.join('\n\n') : undefined
}

/**
 * OpenAI 消息数组转 Anthropic 消息数组（system 在外层单独提取；tool 消息并入 user 的 tool_result 块）
 * @param messages OpenAI 消息数组
 */
function chatMessagesToAnthropic(messages: Array<Record<string, unknown>>): Array<{ role: string; content: AnthropicBlock[] }> {
  const out: Array<{ role: string; content: AnthropicBlock[] }> = []
  for (const m of messages) {
    const role = m.role as string
    if (role === 'system' || role === 'developer') continue
    if (role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: String(m.tool_call_id ?? ''), content: [{ type: 'text', text }] }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
      else if (Array.isArray(m.content)) blocks.push(...openaiPartsToBlocks(m.content as OpenAiPart[]))
      for (const tc of (m.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
        blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), input: tryParseJson(tc.function?.arguments ?? '{}') ?? {} })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    // user 消息
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : openaiPartsToBlocks((m.content as OpenAiPart[]) ?? [])
    out.push({ role: 'user', content })
  }
  return out
}

/**
 * Anthropic 块数组转 OpenAI 内容：纯文本折叠为字符串，含图片时为部件数组
 * @param blocks Anthropic 内容块
 */
function blocksToOpenaiContent(blocks: AnthropicBlock[]): string | OpenAiPart[] {
  if (blocks.every((b) => b.type === 'text')) {
    return blocks.map((b) => b.text ?? '').join('\n')
  }
  const parts: OpenAiPart[] = []
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text ?? '' })
    else if (b.type === 'image' && b.source) {
      const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : (b.source.url ?? '')
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  return parts
}

/**
 * tool_result 块内容提取为字符串
 * @param content tool_result 的 content（字符串或块数组）
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return (content as AnthropicBlock[]).map((b) => b.text ?? '').join('')
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

// ==================== 请求转换 ====================

/**
 * 组装 OpenAI Chat 请求 → Anthropic Messages 请求
 */
function chatReqToAnthropic(body: any, model: string): any {
  const messages = chatMessagesToAnthropic(body.messages ?? [])
  const out: any = {
    model,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_TOKENS,
    messages,
  }
  const system = extractSystem(body.messages ?? [])
  if (system) out.system = system
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  const stop = Array.isArray(body.stop) ? body.stop : typeof body.stop === 'string' ? [body.stop] : undefined
  if (stop && stop.length) out.stop_sequences = stop
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      name: String(t.function?.name ?? ''),
      description: t.function?.description ?? '',
      input_schema: t.function?.parameters ?? { type: 'object' },
    }))
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'function') out.tool_choice = { type: 'tool', name: body.tool_choice.function?.name }
    else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' }
    else if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' }
    else if (body.tool_choice === 'none') out.tool_choice = { type: 'none' }
  }
  if (body.stream) out.stream = true
  return out
}

/**
 * 组装 Anthropic Messages 请求 → OpenAI Chat 请求
 */
function anthropicReqToChat(body: any, model: string): any {
  const messages: Array<Record<string, any>> = []
  if (body.system) {
    const sysText = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? (body.system as AnthropicBlock[]).map((b) => b.text ?? '').join('\n') : ''
    if (sysText) messages.push({ role: 'system', content: sysText })
  }
  for (const m of body.messages ?? []) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const blocks = m.content as AnthropicBlock[]
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: toolResultText(b.content) })
          }
        }
        const others = blocks.filter((b) => b.type !== 'tool_result')
        if (others.length) messages.push({ role: 'user', content: blocksToOpenaiContent(others) })
      } else {
        messages.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = Array.isArray(m.content) ? (m.content as AnthropicBlock[]) : [{ type: 'text', text: String(m.content ?? '') }]
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
      const msg: Record<string, any> = { role: 'assistant', content: text || null }
      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((u) => ({ id: String(u.id ?? ''), type: 'function', function: { name: String(u.name ?? ''), arguments: JSON.stringify(u.input ?? {}) } }))
      }
      messages.push(msg)
    }
  }
  const out: any = { model, messages }
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: { name: String(t.name ?? ''), description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } },
    }))
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'tool') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
    else if (body.tool_choice.type === 'any') out.tool_choice = 'required'
    else if (body.tool_choice.type === 'auto') out.tool_choice = 'auto'
  }
  if (body.stream) out.stream = true
  return out
}

// ==================== 非流式响应转换 ====================

/**
 * Anthropic 非流式响应 → OpenAI Chat 响应
 */
function anthropicRespToChat(up: any, model: string): any {
  const blocks: AnthropicBlock[] = Array.isArray(up.content) ? up.content : []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  const toolUses = blocks.filter((b) => b.type === 'tool_use')
  const message: Record<string, any> = { role: 'assistant', content: text || null }
  if (toolUses.length) {
    message.tool_calls = toolUses.map((u) => ({ id: String(u.id ?? ''), type: 'function', function: { name: String(u.name ?? ''), arguments: JSON.stringify(u.input ?? {}) } }))
  }
  const inputTokens = up.usage?.input_tokens ?? 0
  const outputTokens = up.usage?.output_tokens ?? 0
  return {
    id: `chatcmpl-${String(up.id ?? '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[up.stop_reason] ?? 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  }
}

/**
 * OpenAI Chat 非流式响应 → Anthropic 响应
 */
function chatRespToAnthropic(up: any, model: string): any {
  const choice = up.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const blocks: AnthropicBlock[] = []
  if (typeof msg.content === 'string' && msg.content) blocks.push({ type: 'text', text: msg.content })
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content as OpenAiPart[]) if (p.type === 'text') blocks.push({ type: 'text', text: p.text ?? '' })
  }
  for (const tc of (msg.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
    blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), input: tryParseJson(tc.function?.arguments ?? '{}') ?? {} })
  }
  return {
    id: String(up.id ?? ''),
    model,
    role: 'assistant',
    content: blocks,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: up.usage?.prompt_tokens ?? 0, output_tokens: up.usage?.completion_tokens ?? 0 },
  }
}

// ==================== 流式转换 ====================

/**
 * Anthropic SSE 流 → OpenAI chat chunks 流
 */
async function* anthropicStreamToChat(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let id = 'chatcmpl-unknown'
  let inputTokens = 0
  let outputTokens = 0
  let roleSent = false
  let finishReason: string | undefined
  let closed = false
  /** Anthropic 块索引 → OpenAI tool_calls 索引 */
  const toolIdxByBlock = new Map<number, number>()
  const created = Math.floor(Date.now() / 1000)

  /** 构造一个 chat chunk 的 SSE 编码 */
  const chunk = (delta: any, finish: string | null = null, usage?: any): string => {
    const obj: any = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] }
    if (usage) obj.usage = usage
    return encodeSSE({ data: JSON.stringify(obj) })
  }
  /** 发出 role 首块（幂等） */
  const ensureRole = function* (): Generator<string> {
    if (!roleSent) {
      roleSent = true
      yield chunk({ role: 'assistant', content: '' })
    }
  }

  for await (const ev of parseSSE(upstream)) {
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (d.type === 'message_start') {
      id = `chatcmpl-${String(d.message?.id ?? 'unknown')}`
      inputTokens = d.message?.usage?.input_tokens ?? 0
      yield* ensureRole()
    } else if (d.type === 'content_block_start') {
      yield* ensureRole()
      if (d.content_block?.type === 'tool_use') {
        const tIdx = toolIdxByBlock.size
        toolIdxByBlock.set(d.index, tIdx)
        yield chunk({ tool_calls: [{ index: tIdx, id: String(d.content_block.id ?? ''), type: 'function', function: { name: String(d.content_block.name ?? ''), arguments: '' } }] })
      }
    } else if (d.type === 'content_block_delta') {
      if (d.delta?.type === 'text_delta') {
        yield* ensureRole()
        yield chunk({ content: d.delta.text ?? '' })
      } else if (d.delta?.type === 'input_json_delta') {
        yield chunk({ tool_calls: [{ index: toolIdxByBlock.get(d.index) ?? 0, function: { arguments: d.delta.partial_json ?? '' } }] })
      }
    } else if (d.type === 'message_delta') {
      if (d.usage?.output_tokens !== undefined) outputTokens = d.usage.output_tokens
      if (d.delta?.stop_reason) finishReason = STOP_TO_FINISH[d.delta.stop_reason] ?? 'stop'
    } else if (d.type === 'message_stop') {
      yield chunk({}, finishReason ?? 'stop', { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens })
      yield encodeSSE({ data: '[DONE]' })
      closed = true
    }
  }
  // 上游未正常结束（中断）：补收尾
  if (!closed) {
    yield* ensureRole()
    yield chunk({}, finishReason ?? 'stop', { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens })
    yield encodeSSE({ data: '[DONE]' })
  }
}

/**
 * OpenAI chat chunks 流 → Anthropic SSE 流
 */
async function* chatStreamToAnthropic(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let started = false
  let blockOpen = false
  let blockIdx = 0
  let finishReason: string | undefined
  /** 待产出的事件编码队列 */
  const q: string[] = []
  /** 把 Anthropic 事件对象编码入队 */
  const push = (obj: any): void => {
    q.push(encodeSSE({ event: obj.type, data: JSON.stringify(obj) }))
  }

  for await (const ev of parseSSE(upstream)) {
    if (ev.data === '[DONE]') break
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (!started) {
      started = true
      push({ type: 'message_start', message: { id: String(d.id ?? ''), model, role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    }
    const choice = d.choices?.[0]
    const delta = choice?.delta ?? {}
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!blockOpen) {
        push({ type: 'content_block_start', index: blockIdx, content_block: { type: 'text' } })
        blockOpen = true
      }
      push({ type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: delta.content } })
    }
    for (const tc of (delta.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
      if (tc.id || tc.function?.name) {
        // 新工具调用开始：关闭当前块（若有）
        if (blockOpen) {
          push({ type: 'content_block_stop', index: blockIdx })
          blockIdx++
        }
        push({ type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? '') } })
        blockOpen = true
      }
      if (tc.function?.arguments) {
        push({ type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    yield* q.splice(0)
  }
  // 收尾（正常与中断都走这里）：关闭未关块、message_delta、message_stop
  if (blockOpen) {
    push({ type: 'content_block_stop', index: blockIdx })
  }
  push({ type: 'message_delta', delta: { stop_reason: FINISH_TO_STOP[finishReason ?? 'stop'] ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
  push({ type: 'message_stop' })
  yield* q.splice(0)
}

// ==================== 导出的两对转换器 ====================
// ConvPair 语义：convertRequest 客户端→上游；convertResponse / convertStream 上游→客户端

/** OpenAI Chat 客户端 → Anthropic 上游 */
export const chatToAnthropic: ConvPair = {
  convertRequest: chatReqToAnthropic,
  convertResponse: anthropicRespToChat,
  convertStream: (upstream, model) => sseStreamFromGenerator(anthropicStreamToChat(upstream, model)),
}

/** Anthropic 客户端 → OpenAI Chat 上游 */
export const anthropicToChat: ConvPair = {
  convertRequest: anthropicReqToChat,
  convertResponse: chatRespToAnthropic,
  convertStream: (upstream, model) => sseStreamFromGenerator(chatStreamToAnthropic(upstream, model)),
}
