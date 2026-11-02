// OpenAI Responses ↔ Anthropic Messages 双向转换器
import { encodeSSE, parseSSE } from './sse'
import { sseStreamFromGenerator, tryParseJson, type ConvPair } from './types'

/** 转 Anthropic 方向 max_tokens 缺省值 */
const DEFAULT_MAX_TOKENS = 4096

/** Anthropic 内容块（本文件内使用的字段子集） */
interface ABlock {
  /** 块类型 */
  type: string
  /** 文本（text 块） */
  text?: string
  /** 图片来源（image 块） */
  source?: { type: string; media_type?: string; data?: string; url?: string }
  /** 工具调用 ID（tool_use） */
  id?: string
  /** 工具名（tool_use） */
  name?: string
  /** 工具入参（tool_use） */
  input?: unknown
  /** 对应 tool_use 的 ID（tool_result） */
  tool_use_id?: string
  /** 工具结果内容（tool_result） */
  content?: unknown
}

/** Responses 输入项（message / function_call / function_call_output） */
interface RItem {
  /** 项类型 */
  type: string
  /** 角色（message 项） */
  role?: string
  /** 消息内容（message 项，字符串或部件数组） */
  content?: unknown
  /** 调用 ID（function_call / function_call_output 项，对应 call_id） */
  call_id?: string
  /** 工具名（function_call 项） */
  name?: string
  /** 工具参数 JSON 字符串（function_call 项） */
  arguments?: string
  /** 工具输出文本（function_call_output 项） */
  output?: string
  /** 项 id（msg_/fc_ 等，输出项携带） */
  id?: string
}

/**
 * Responses 消息内容部件转 Anthropic 块（input_text/output_text → text；input_image → image）
 * @param parts 内容部件数组
 */
function rPartsToBlocks(parts: Array<Record<string, any>>): ABlock[] {
  const blocks: ABlock[] = []
  for (const p of parts) {
    if (p.type === 'input_text' || p.type === 'output_text') {
      blocks.push({ type: 'text', text: String(p.text ?? '') })
    } else if (p.type === 'input_image') {
      const url = String(p.image_url ?? '')
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      else blocks.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return blocks
}

/**
 * tool_result 内容提取为字符串
 * @param content tool_result 的 content
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return (content as ABlock[]).map((b) => b.text ?? '').join('')
  if (content == null) return ''
  return JSON.stringify(content)
}

/**
 * 把 Anthropic 块数组转 Responses 消息内容部件（input_text/input_image）
 * @param blocks Anthropic 内容块
 */
function blocksToRParts(blocks: ABlock[]): Array<Record<string, any>> {
  return blocks.map((b) => {
    if (b.type === 'text') return { type: 'input_text', text: b.text ?? '' }
    if (b.type === 'image' && b.source) {
      const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : (b.source.url ?? '')
      return { type: 'input_image', image_url: url }
    }
    return { type: 'input_text', text: '' }
  })
}

// ==================== 请求转换 ====================

/**
 * Responses 请求 → Anthropic 请求
 */
function responsesReqToAnthropic(body: any, model: string): any {
  const input: RItem[] = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : (body.input ?? [])
  const systemTexts: string[] = []
  if (typeof body.instructions === 'string' && body.instructions) systemTexts.push(body.instructions)

  const messages: Array<{ role: string; content: ABlock[] }> = []
  for (const item of input) {
    // 无 type 字段但有 role 的项按 EasyInputMessage 处理（OpenAI 最常用形态）
    const isMessage = item.type === 'message' || (item.type === undefined && typeof item.role === 'string')
    if (isMessage) {
      if (item.role === 'system' || item.role === 'developer') {
        const text = typeof item.content === 'string' ? item.content : (Array.isArray(item.content) ? (item.content as Array<Record<string, any>>).map((p) => String(p.text ?? '')).join('') : '')
        if (text) systemTexts.push(text)
        continue
      }
      const blocks = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : rPartsToBlocks((item.content as Array<Record<string, any>>) ?? [])
      if (item.role === 'assistant') {
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant') last.content.push(...blocks)
        else messages.push({ role: 'assistant', content: blocks })
      } else {
        messages.push({ role: 'user', content: blocks })
      }
    } else if (item.type === 'function_call') {
      const block: ABlock = { type: 'tool_use', id: String(item.call_id ?? ''), name: String(item.name ?? ''), input: tryParseJson(item.arguments ?? '{}') ?? {} }
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') last.content.push(block)
      else messages.push({ role: 'assistant', content: [block] })
    } else if (item.type === 'function_call_output') {
      const block: ABlock = { type: 'tool_result', tool_use_id: String(item.call_id ?? ''), content: [{ type: 'text', text: String(item.output ?? '') }] }
      const last = messages[messages.length - 1]
      if (last && last.role === 'user' && last.content[0]?.type === 'tool_result') last.content.push(block)
      else messages.push({ role: 'user', content: [block] })
    }
  }

  const out: any = {
    model,
    max_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : DEFAULT_MAX_TOKENS,
    messages,
  }
  if (systemTexts.length) out.system = systemTexts.join('\n\n')
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      name: String(t.name ?? ''),
      description: t.description ?? '',
      input_schema: t.parameters ?? { type: 'object' },
    }))
  }
  if (body.stream) out.stream = true
  return out
}

/**
 * Anthropic 请求 → Responses 请求
 */
function anthropicReqToResponses(body: any, model: string): any {
  const items: RItem[] = []
  for (const m of body.messages ?? []) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        for (const b of m.content as ABlock[]) {
          if (b.type === 'tool_result') {
            items.push({ type: 'function_call_output', call_id: String(b.tool_use_id ?? ''), output: toolResultText(b.content) })
          }
        }
        const others = (m.content as ABlock[]).filter((b) => b.type !== 'tool_result')
        if (others.length) items.push({ type: 'message', role: 'user', content: blocksToRParts(others) })
      } else {
        items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(m.content ?? '') }] })
      }
    } else if (m.role === 'assistant') {
      const blocks: ABlock[] = Array.isArray(m.content) ? (m.content as ABlock[]) : [{ type: 'text', text: String(m.content ?? '') }]
      const texts = blocks.filter((b) => b.type === 'text' && b.text)
      if (texts.length) {
        items.push({ type: 'message', role: 'assistant', content: texts.map((b) => ({ type: 'output_text', text: b.text })) })
      }
      for (const u of blocks.filter((b) => b.type === 'tool_use')) {
        items.push({ type: 'function_call', call_id: String(u.id ?? ''), name: String(u.name ?? ''), arguments: JSON.stringify(u.input ?? {}) })
      }
    }
  }
  const out: any = { model, input: items }
  if (typeof body.system === 'string' && body.system) out.instructions = body.system
  else if (Array.isArray(body.system)) {
    const text = (body.system as ABlock[]).map((b) => b.text ?? '').join('\n')
    if (text) out.instructions = text
  }
  if (typeof body.max_tokens === 'number') out.max_output_tokens = body.max_tokens
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      name: String(t.name ?? ''),
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object' },
    }))
  }
  if (body.stream) out.stream = true
  return out
}

// ==================== 非流式响应转换 ====================

/**
 * Responses 响应 → Anthropic 响应
 */
function responsesRespToAnthropic(up: any, model: string): any {
  const blocks: ABlock[] = []
  let hasToolUse = false
  for (const item of (up.output ?? []) as RItem[]) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const p of item.content as Array<Record<string, any>>) {
        if (p.type === 'output_text' && p.text) blocks.push({ type: 'text', text: String(p.text) })
      }
    } else if (item.type === 'function_call') {
      hasToolUse = true
      blocks.push({ type: 'tool_use', id: String(item.call_id ?? ''), name: String(item.name ?? ''), input: tryParseJson(item.arguments ?? '{}') ?? {} })
    }
  }
  return {
    id: String(up.id ?? ''),
    model,
    role: 'assistant',
    content: blocks,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: up.usage?.input_tokens ?? 0, output_tokens: up.usage?.output_tokens ?? 0 },
  }
}

/**
 * Anthropic 响应 → Responses 响应（id 由网关状态层改写）
 */
function anthropicRespToResponses(up: any, model: string): any {
  const output: RItem[] = []
  const blocks: ABlock[] = Array.isArray(up.content) ? (up.content as ABlock[]) : []
  const texts = blocks.filter((b) => b.type === 'text' && b.text)
  if (texts.length) {
    output.push({ type: 'message', role: 'assistant', content: texts.map((b) => ({ type: 'output_text', text: b.text })) })
  }
  for (const u of blocks.filter((b) => b.type === 'tool_use')) {
    output.push({ type: 'function_call', call_id: String(u.id ?? ''), name: String(u.name ?? ''), arguments: JSON.stringify(u.input ?? {}) })
  }
  const inputTokens = up.usage?.input_tokens ?? 0
  const outputTokens = up.usage?.output_tokens ?? 0
  return {
    id: String(up.id ?? ''),
    object: 'response',
    status: 'completed',
    model,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  }
}

// ==================== 流式转换 ====================

/**
 * Responses SSE 流 → Anthropic SSE 流
 */
async function* responsesStreamToAnthropic(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let started = false
  let blockOpen = false
  let blockIdx = 0
  let hasToolUse = false
  let outputTokens = 0
  let closed = false
  const q: string[] = []
  const push = (obj: any): void => {
    q.push(encodeSSE({ event: obj.type, data: JSON.stringify(obj) }))
  }

  for await (const ev of parseSSE(upstream)) {
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (!started && (d.type === 'response.created' || d.type === 'response.output_item.added' || d.type === 'response.output_text.delta')) {
      started = true
      push({ type: 'message_start', message: { id: String(d.response?.id ?? ''), model, role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    }
    if (d.type === 'response.output_item.added') {
      const item = d.item ?? {}
      if (item.type === 'message') {
        push({ type: 'content_block_start', index: blockIdx, content_block: { type: 'text' } })
        blockOpen = true
      } else if (item.type === 'function_call') {
        hasToolUse = true
        if (blockOpen) {
          push({ type: 'content_block_stop', index: blockIdx })
          blockIdx++
        }
        push({ type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: String(item.call_id ?? ''), name: String(item.name ?? '') } })
        blockOpen = true
      }
    } else if (d.type === 'response.output_text.delta') {
      if (!blockOpen) {
        push({ type: 'content_block_start', index: blockIdx, content_block: { type: 'text' } })
        blockOpen = true
      }
      push({ type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: String(d.delta ?? '') } })
    } else if (d.type === 'response.function_call_arguments.delta') {
      push({ type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: String(d.delta ?? '') } })
    } else if (d.type === 'response.output_item.done') {
      if (blockOpen) {
        push({ type: 'content_block_stop', index: blockIdx })
        blockIdx++
        blockOpen = false
      }
    } else if (d.type === 'response.completed' || d.type === 'response.failed' || d.type === 'response.incomplete') {
      outputTokens = d.response?.usage?.output_tokens ?? outputTokens
      const stopReason = d.type === 'response.completed' ? (hasToolUse ? 'tool_use' : 'end_turn') : d.type === 'response.incomplete' ? 'max_tokens' : 'refusal'
      if (blockOpen) {
        push({ type: 'content_block_stop', index: blockIdx })
        blockOpen = false
      }
      push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
      push({ type: 'message_stop' })
      closed = true
    }
    yield* q.splice(0)
  }
  // 上游中断：补收尾
  if (!closed) {
    if (blockOpen) push({ type: 'content_block_stop', index: blockIdx })
    push({ type: 'message_delta', delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
    push({ type: 'message_stop' })
    yield* q.splice(0)
  }
}

/**
 * Anthropic SSE 流 → Responses SSE 流
 */
async function* anthropicStreamToResponses(upstream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let respId = 'resp_pending' // 占位 id（网关状态层会改写为自己的 id）
  let inputTokens = 0
  let outputTokens = 0
  let itemIndex = 0
  /** 当前块索引对应的输出项快照 */
  let currentItem: Record<string, any> | null = null
  let hasFunctionCall = false
  /** 已完成项快照（completed 事件的 output 用） */
  const doneItems: Array<Record<string, any>> = []
  const q: string[] = []
  const push = (obj: any): void => {
    q.push(encodeSSE({ event: obj.type, data: JSON.stringify(obj) }))
  }
  /** 响应对象骨架 */
  const responseObject = (status: string): Record<string, any> => ({
    id: respId,
    object: 'response',
    status,
    model,
    output: [],
  })

  for await (const ev of parseSSE(upstream)) {
    const d = tryParseJson(ev.data)
    if (!d) continue
    if (d.type === 'message_start') {
      inputTokens = d.message?.usage?.input_tokens ?? 0
      push({ type: 'response.created', response: responseObject('in_progress') })
    } else if (d.type === 'content_block_start') {
      const cb = d.content_block ?? {}
      if (cb.type === 'text') {
        currentItem = { type: 'message', id: `msg_${itemIndex}`, role: 'assistant', content: [] }
        push({ type: 'response.output_item.added', output_index: itemIndex, item: currentItem })
      } else if (cb.type === 'tool_use') {
        hasFunctionCall = true
        currentItem = { type: 'function_call', id: `fc_${itemIndex}`, call_id: String(cb.id ?? ''), name: String(cb.name ?? ''), arguments: '' }
        push({ type: 'response.output_item.added', output_index: itemIndex, item: currentItem })
      }
    } else if (d.type === 'content_block_delta') {
      if (d.delta?.type === 'text_delta' && currentItem) {
        if (currentItem.type === 'message') {
          // 累积文本（done item 保留完整内容）
          const prev = String(currentItem.content?.[0]?.text ?? '')
          currentItem.content = [{ type: 'output_text', text: prev + String(d.delta.text ?? '') }]
        }
        push({ type: 'response.output_text.delta', output_index: itemIndex, delta: String(d.delta.text ?? '') })
      } else if (d.delta?.type === 'input_json_delta' && currentItem?.type === 'function_call') {
        // 累积参数片段
        currentItem.arguments = String(currentItem.arguments ?? '') + String(d.delta.partial_json ?? '')
        push({ type: 'response.function_call_arguments.delta', output_index: itemIndex, delta: String(d.delta.partial_json ?? '') })
      }
    } else if (d.type === 'content_block_stop') {
      if (currentItem) {
        push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
        doneItems.push(currentItem)
        itemIndex++
        currentItem = null
      }
    } else if (d.type === 'message_delta') {
      if (d.usage?.output_tokens !== undefined) outputTokens = d.usage.output_tokens
    } else if (d.type === 'message_stop') {
      if (currentItem) {
        push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
        doneItems.push(currentItem)
        itemIndex++
        currentItem = null
      }
      const resp = responseObject('completed')
      resp.output = doneItems
      resp.usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
      push({ type: 'response.completed', response: resp })
    }
    yield* q.splice(0)
  }
  // 上游中断：补收尾事件
  if (currentItem) {
    push({ type: 'response.output_item.done', output_index: itemIndex, item: currentItem })
    doneItems.push(currentItem)
    currentItem = null
  }
  const resp = responseObject('incomplete')
  resp.output = doneItems
  resp.usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
  push({ type: 'response.incomplete', response: resp })
  yield* q.splice(0)
}

// ==================== 导出的两对转换器 ====================
// ConvPair 语义：convertRequest 客户端→上游；convertResponse / convertStream 上游→客户端

/** OpenAI Responses 客户端 → Anthropic 上游 */
export const responsesToAnthropic: ConvPair = {
  convertRequest: responsesReqToAnthropic,
  convertResponse: anthropicRespToResponses,
  convertStream: (upstream, model) => sseStreamFromGenerator(anthropicStreamToResponses(upstream, model)),
}

/** Anthropic 客户端 → OpenAI Responses 上游 */
export const anthropicToResponses: ConvPair = {
  convertRequest: anthropicReqToResponses,
  convertResponse: responsesRespToAnthropic,
  convertStream: (upstream, model) => sseStreamFromGenerator(responsesStreamToAnthropic(upstream, model)),
}
