// Task 9：OpenAI Chat ↔ OpenAI Responses 转换器测试
import { expect, it } from 'vitest'
import { chatToResponses, responsesToChat } from '../src/worker/convert/chat_responses'
import { parseSSE, type SseEvent } from '../src/worker/convert/sse'

/** 把若干 SSE 文本段拼成字节流 */
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

/** 读取并解析事件 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of parseSSE(stream)) out.push(ev)
  return out
}

// —— 请求：Chat → Responses ——

it('chatToResponses 请求：system 转 instructions、tool 消息转 items、参数映射', () => {
  const out = chatToResponses.convertRequest(
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '北京天气' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '晴' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      max_tokens: 100,
      temperature: 0.3,
    },
    'gpt-5',
  )
  expect(out.instructions).toBe('你是助手')
  expect(out.max_output_tokens).toBe(100)
  expect(out.temperature).toBe(0.3)
  expect(out.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京天气' }] },
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '晴' },
  ])
  expect(out.tools).toEqual([{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }])
})

// —— 请求：Responses → Chat ——

it('responsesToChat 请求：instructions 转 system、items 转消息（含图片与工具）', () => {
  const out = responsesToChat.convertRequest(
    {
      model: 'gpt-5',
      instructions: '你是助手',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '看图' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          ],
        },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '晴' },
      ],
      tools: [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object' } }],
      max_output_tokens: 200,
    },
    'gpt-4o',
  )
  expect(out.messages).toEqual([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '晴' },
  ])
  expect(out.max_tokens).toBe(200)
  expect(out.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } } }])
})

// —— 非流式响应 ——

it('chatToResponses 响应：Responses 输出转 chat completion', () => {
  const out = chatToResponses.convertResponse(
    {
      id: 'resp_1',
      model: 'gpt-5',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '查一下' }] },
        { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"北京"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    'gpt-4o',
  )
  expect(out.object).toBe('chat.completion')
  expect(out.choices[0].message.content).toBe('查一下')
  expect(out.choices[0].message.tool_calls).toEqual([{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }])
  expect(out.choices[0].finish_reason).toBe('tool_calls')
  expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

it('responsesToChat 响应：chat completion 转 Responses 对象', () => {
  const out = responsesToChat.convertResponse(
    {
      id: 'cc_1',
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
    'gpt-5',
  )
  expect(out.object).toBe('response')
  expect(out.status).toBe('completed')
  expect(out.output).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案' }] }])
  expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 })
})

// —— 流式：Responses SSE → Chat chunks ——

it('chatToResponses 流式：Responses 事件转 chat chunks 且以 [DONE] 结束', async () => {
  const events = await readStream(
    chatToResponses.convertStream(
      sseStream(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
      ),
      'gpt-4o',
    ),
  )
  expect(events[events.length - 1].data).toBe('[DONE]')
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data))
  expect(chunks[0].choices[0].delta.role).toBe('assistant')
  expect(chunks[1].choices[0].delta.content).toBe('你')
  expect(chunks[2].choices[0].delta.content).toBe('好')
  const last = chunks[chunks.length - 1]
  expect(last.choices[0].finish_reason).toBe('stop')
  expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

it('chatToResponses 流式：function_call 增量转 tool_calls', async () => {
  const events = await readStream(
    chatToResponses.convertStream(
      sseStream(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_7","name":"get_weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\":\\"北京\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
      ),
      'gpt-4o',
    ),
  )
  const chunks = events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => JSON.parse(e.data))
    .filter((c) => c.choices?.[0]?.delta?.tool_calls)
  expect(chunks[0].choices[0].delta.tool_calls).toMatchObject([{ index: 0, id: 'call_7', type: 'function', function: { name: 'get_weather' } }])
  const frags = chunks.slice(1).map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
  expect(frags.join('')).toBe('{"city":"北京"}')
})

// —— 流式：Chat chunks → Responses 事件 ——

it('responsesToChat 流式：chat chunks 转 Responses 事件序列', async () => {
  const events = await readStream(
    responsesToChat.convertStream(
      sseStream(
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  expect(objs[0].type).toBe('response.created')
  const added = objs.find((o) => o.type === 'response.output_item.added')
  expect(added.item.type).toBe('message')
  const deltas = objs.filter((o) => o.type === 'response.output_text.delta').map((o) => o.delta)
  expect(deltas.join('')).toBe('你好')
  const done = objs.find((o) => o.type === 'response.output_item.done')
  expect(done.item.type).toBe('message')
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.status).toBe('completed')
})

it('responsesToChat 流式：tool_calls 增量转函数调用事件', async () => {
  const events = await readStream(
    responsesToChat.convertStream(
      sseStream(
        'data: {"id":"cc","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"北京\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const added = objs.find((o) => o.type === 'response.output_item.added')
  expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_7', name: 'get_weather' })
  const argDeltas = objs.filter((o) => o.type === 'response.function_call_arguments.delta').map((o) => o.delta)
  expect(argDeltas.join('')).toBe('{"city":"北京"}')
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.status).toBe('completed')
})

// —— 修复回合：评审 C2/I1/I5 ——

// C2：多片段 content 累积，done item 内容完整；completed.output 非空；created id 为 resp_ 前缀
it('responsesToChat 流式：多片段累积，done 与 completed 的内容完整', async () => {
  const events = await readStream(
    responsesToChat.convertStream(
      sseStream(
        'data: {"id":"cc","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const done = objs.find((o) => o.type === 'response.output_item.done')
  expect(done.item.content).toEqual([{ type: 'output_text', text: '你好' }])
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.output).toMatchObject([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }])
  const created = objs.find((o) => o.type === 'response.created')
  expect(String(created.response.id)).toMatch(/^resp_/)
})

// C2：多片段工具参数累积
it('responsesToChat 流式：多片段工具参数累积完整', async () => {
  const events = await readStream(
    responsesToChat.convertStream(
      sseStream(
        'data: {"id":"cc","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"北京\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"cc","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const done = objs.find((o) => o.type === 'response.output_item.done')
  expect(done.item.arguments).toBe('{"city":"北京"}')
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.output[0].arguments).toBe('{"city":"北京"}')
})

// I5：EasyInputMessage（无 type 字段）按 message 处理
it('responsesToChat 请求：无 type 字段的 EasyInputMessage 不被丢弃', () => {
  const out = responsesToChat.convertRequest(
    {
      model: 'gpt-5',
      input: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
      ],
    },
    'gpt-4o',
  )
  expect(out.messages).toEqual([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在的' },
  ])
})
