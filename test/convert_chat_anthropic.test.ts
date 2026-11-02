// Task 7：OpenAI Chat ↔ Anthropic Messages 转换器测试（请求/响应/流式三面）
import { expect, it } from 'vitest'
import { chatToAnthropic, anthropicToChat } from '../src/worker/convert/chat_anthropic'
import { parseSSE, type SseEvent } from '../src/worker/convert/sse'

/** 把若干 SSE 文本段拼成字节流（每段一个 chunk） */
function sseStream(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]))
      else controller.close()
    },
  })
}

/** 读取转换后的字节流并解析为事件 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of parseSSE(stream)) out.push(ev)
  return out
}

// —— 请求方向：Chat → Anthropic ——

// system 消息提出为顶层 system（多条以 \n\n 连接）；max_tokens 缺省补 4096；基础参数映射
it('chatToAnthropic 请求：system 提取、max_tokens 补 4096、参数映射、模型改名', async () => {
  const out = chatToAnthropic.convertRequest(
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: '规则一' },
        { role: 'system', content: '规则二' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
        { role: 'user', content: '再见' },
      ],
      temperature: 0.5,
      top_p: 0.9,
      stop: ['END', 'STOP'],
      stream: true,
    },
    'gpt-4o-2024-08-06',
  )
  expect(out.system).toBe('规则一\n\n规则二')
  expect(out.max_tokens).toBe(4096)
  expect(out.temperature).toBe(0.5)
  expect(out.top_p).toBe(0.9)
  expect(out.stop_sequences).toEqual(['END', 'STOP'])
  expect(out.model).toBe('gpt-4o-2024-08-06')
  expect(out.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
    { role: 'user', content: [{ type: 'text', text: '再见' }] },
  ])
})

// 多模态图片：data URL 拆为 base64 source；http URL 用 url source
it('chatToAnthropic 请求：图片 data URL 拆 base64 source、http URL 用 url source', () => {
  const out = chatToAnthropic.convertRequest(
    {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
          ],
        },
      ],
    },
    'gpt-4o',
  )
  expect(out.messages[0].content).toEqual([
    { type: 'text', text: '看图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/a.png' } },
  ])
})

// 工具：定义互转；assistant tool_calls → tool_use；role:tool → tool_result
it('chatToAnthropic 请求：工具定义与调用往返映射', () => {
  const out = chatToAnthropic.convertRequest(
    {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: '北京天气' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '晴' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    },
    'gpt-4o',
  )
  expect(out.tools).toEqual([
    { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
  ])
  expect(out.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '北京天气' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '晴' }] }] },
  ])
})

// —— 请求方向：Anthropic → Chat ——

// system 顶层参数转 system 消息；content 块转 content（纯文本折叠为字符串）；stop_sequences → stop
it('anthropicToChat 请求：system 转消息、块折叠、参数映射', () => {
  const out = anthropicToChat.convertRequest(
    {
      model: 'claude-3-5',
      system: '你是助手',
      max_tokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '在吗' }] },
        { role: 'assistant', content: '在的' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          ],
        },
      ],
      stop_sequences: ['END'],
    },
    'claude-3-5-sonnet',
  )
  expect(out.messages).toEqual([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好\n在吗' },
    { role: 'assistant', content: '在的' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
  ])
  expect(out.model).toBe('claude-3-5-sonnet')
  expect(out.max_tokens).toBe(100)
  expect(out.stop).toEqual(['END'])
})

// tool_use / tool_result 转回 OpenAI 形态
it('anthropicToChat 请求：tool_use 与 tool_result 映射', () => {
  const out = anthropicToChat.convertRequest(
    {
      model: 'claude-3-5',
      messages: [
        { role: 'user', content: '北京天气' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] },
      ],
    },
    'claude-3-5',
  )
  expect(out.messages).toEqual([
    { role: 'user', content: '北京天气' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '晴' },
  ])
})

// —— 非流式响应 ——

// Anthropic 响应 → Chat 响应（文本 + 工具调用 + usage + finish_reason 映射）
it('chatToAnthropic 响应：Anthropic 上游响应转回 Chat 形状', () => {
  const out = chatToAnthropic.convertResponse(
    {
      id: 'msg_1',
      model: 'claude-3-5',
      role: 'assistant',
      content: [
        { type: 'text', text: '查一下' },
        { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '北京' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'gpt-4o',
  )
  expect(out.object).toBe('chat.completion')
  expect(out.choices).toHaveLength(1)
  expect(out.choices[0].message.content).toBe('查一下')
  expect(out.choices[0].message.tool_calls).toEqual([{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }])
  expect(out.choices[0].finish_reason).toBe('tool_calls')
  expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

// Chat 响应 → Anthropic 响应（finish_reason 反向映射）
it('anthropicToChat 响应：Chat 上游响应转回 Anthropic 形状', () => {
  const out = anthropicToChat.convertResponse(
    {
      id: 'cc_1',
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: '答案', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
    'claude-3-5',
  )
  expect(out.role).toBe('assistant')
  expect(out.content).toEqual([
    { type: 'text', text: '答案' },
    { type: 'tool_use', id: 'call_1', name: 'f', input: {} },
  ])
  expect(out.stop_reason).toBe('tool_use')
  expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4 })
})

// —— 流式：Anthropic SSE → Chat chunks ——

it('chatToAnthropic 流式：Anthropic 上游事件转 chat chunks 且以 [DONE] 结束', async () => {
  const events = await readStream(
    chatToAnthropic.convertStream(
      sseStream(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      'gpt-4o',
    ),
  )
  // 最后是 [DONE]
  expect(events[events.length - 1].data).toBe('[DONE]')
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data))
  // 首块带 role
  expect(chunks[0].choices[0].delta.role).toBe('assistant')
  expect(chunks[0].object).toBe('chat.completion.chunk')
  // 文本增量
  expect(chunks[1].choices[0].delta.content).toBe('你')
  expect(chunks[2].choices[0].delta.content).toBe('好')
  // 收尾块带 finish_reason 与 usage
  const last = chunks[chunks.length - 1]
  expect(last.choices[0].finish_reason).toBe('stop')
  expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

it('chatToAnthropic 流式：tool_use 增量转 tool_calls（id/name 首块、arguments 逐段）', async () => {
  const events = await readStream(
    chatToAnthropic.convertStream(
      sseStream(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_7","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"ci"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\\":\\"北京\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      'gpt-4o',
    ),
  )
  expect(events[events.length - 1].data).toBe('[DONE]')
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data)).filter((c) => c.choices?.[0]?.delta?.tool_calls)
  expect(chunks[0].choices[0].delta.tool_calls).toEqual([{ index: 0, id: 'call_7', type: 'function', function: { name: 'get_weather', arguments: '' } }])
  const argFrags = chunks.slice(1).map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
  expect(argFrags.join('')).toBe('{"city":"北京"}')
})

// —— 流式：Chat SSE → Anthropic 事件 ——

it('anthropicToChat 流式：chat 上游 chunks 转完整 Anthropic 事件序列', async () => {
  const events = await readStream(
    anthropicToChat.convertStream(
      sseStream(
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      'claude-3-5',
    ),
  )
  const types = events.map((e) => JSON.parse(e.data).type)
  expect(types[0]).toBe('message_start')
  expect(types).toContain('content_block_start')
  expect(types).toContain('content_block_delta')
  expect(types).toContain('content_block_stop')
  expect(types).toContain('message_delta')
  expect(types[types.length - 1]).toBe('message_stop')
  const textDelta = events.map((e) => JSON.parse(e.data)).find((d) => d.type === 'content_block_delta')
  expect(textDelta.delta).toEqual({ type: 'text_delta', text: '你好' })
  const msgDelta = events.map((e) => JSON.parse(e.data)).find((d) => d.type === 'message_delta')
  expect(msgDelta.delta.stop_reason).toBe('end_turn')
})

// 流式中断（上游提前 close）：输出端优雅收尾（补 content_block_stop / message_delta / message_stop）
it('anthropicToChat 流式：上游中断时输出端优雅收尾', async () => {
  const events = await readStream(
    anthropicToChat.convertStream(
      sseStream(
        'data: {"id":"cc","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"content":"部分"},"finish_reason":null}]}\n\n',
        // 没有 finish chunk 与 [DONE]，流直接结束
      ),
      'claude-3-5',
    ),
  )
  const types = events.map((e) => JSON.parse(e.data).type)
  expect(types[0]).toBe('message_start')
  expect(types[types.length - 1]).toBe('message_stop')
  expect(types).toContain('content_block_stop')
  expect(types).toContain('message_delta')
})
