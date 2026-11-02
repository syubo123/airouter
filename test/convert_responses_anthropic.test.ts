// Task 8：OpenAI Responses ↔ Anthropic Messages 转换器测试
import { expect, it } from 'vitest'
import { responsesToAnthropic, anthropicToResponses } from '../src/worker/convert/responses_anthropic'
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

// —— 请求方向：Responses → Anthropic ——

it('responsesToAnthropic 请求：instructions/system 合并、消息与工具往返、max_tokens 补 4096', () => {
  const out = responsesToAnthropic.convertRequest(
    {
      model: 'gpt-5',
      instructions: '规则一',
      input: [
        { type: 'message', role: 'system', content: '规则二' },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '看图' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '晴' },
        { type: 'message', role: 'user', content: '谢谢' },
      ],
      tools: [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      temperature: 0.7,
    },
    'claude-3-5',
  )
  expect(out.system).toBe('规则一\n\n规则二')
  expect(out.max_tokens).toBe(4096)
  expect(out.temperature).toBe(0.7)
  expect(out.model).toBe('claude-3-5')
  expect(out.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '晴' }] }] },
    { role: 'user', content: [{ type: 'text', text: '谢谢' }] },
  ])
  expect(out.tools).toEqual([{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }])
})

// input 为纯字符串时包装为 user 消息
it('responsesToAnthropic 请求：input 字符串包装为 user 文本块', () => {
  const out = responsesToAnthropic.convertRequest({ model: 'm', input: '你好' }, 'm2')
  expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
})

// —— 请求方向：Anthropic → Responses ——

it('anthropicToResponses 请求：system 转 instructions、tool_use/tool_result 转 items', () => {
  const out = anthropicToResponses.convertRequest(
    {
      model: 'claude-3-5',
      system: '你是助手',
      max_tokens: 88,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '北京天气' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] },
      ],
    },
    'gpt-5',
  )
  expect(out.instructions).toBe('你是助手')
  expect(out.max_output_tokens).toBe(88)
  expect(out.input).toEqual([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京天气' }] },
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '晴' },
  ])
})

// —— 非流式响应 ——

it('anthropicToResponses 响应：Responses 上游响应转回 Anthropic 形状', () => {
  const out = anthropicToResponses.convertResponse(
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
    'claude-3-5',
  )
  expect(out.role).toBe('assistant')
  expect(out.content).toEqual([
    { type: 'text', text: '查一下' },
    { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '北京' } },
  ])
  expect(out.stop_reason).toBe('tool_use')
  expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
})

it('responsesToAnthropic 响应：Anthropic 上游响应转回 Responses 形状', () => {
  const out = responsesToAnthropic.convertResponse(
    { id: 'msg_1', content: [{ type: 'text', text: '答案' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } },
    'gpt-5',
  )
  expect(out.object).toBe('response')
  expect(out.status).toBe('completed')
  expect(out.output).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案' }] }])
  expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 })
})

// —— 流式：Responses SSE → Anthropic 事件 ——

it('anthropicToResponses 流式：Responses 上游文本 delta 转 Anthropic 事件序列', async () => {
  const events = await readStream(
    anthropicToResponses.convertStream(
      sseStream(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","usage":null}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好"}]}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
      ),
      'claude-3-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  expect(objs.map((o) => o.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  expect(objs[1].content_block).toEqual({ type: 'text' })
  expect(objs[2].delta).toEqual({ type: 'text_delta', text: '你' })
  expect(objs[3].delta).toEqual({ type: 'text_delta', text: '好' })
  expect(objs[5].delta.stop_reason).toBe('end_turn')
  expect(objs[5].usage.output_tokens).toBe(5)
})

it('anthropicToResponses 流式：function_call 增量转 tool_use 块', async () => {
  const events = await readStream(
    anthropicToResponses.convertStream(
      sseStream(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","usage":null}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_7","name":"get_weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"ci"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"ty\\":\\"北京\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_7","name":"get_weather","arguments":"{}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
      ),
      'claude-3-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const start = objs.find((o) => o.type === 'content_block_start')
  expect(start.content_block).toEqual({ type: 'tool_use', id: 'call_7', name: 'get_weather' })
  const frags = objs.filter((o) => o.type === 'content_block_delta' && o.delta.type === 'input_json_delta').map((o) => o.delta.partial_json)
  expect(frags.join('')).toBe('{"city":"北京"}')
  const msgDelta = objs.find((o) => o.type === 'message_delta')
  expect(msgDelta.delta.stop_reason).toBe('tool_use')
})

// —— 流式：Anthropic SSE → Responses 事件 ——

it('responsesToAnthropic 流式：Anthropic 上游事件转 Responses 事件序列', async () => {
  const events = await readStream(
    responsesToAnthropic.convertStream(
      sseStream(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  expect(objs[0].type).toBe('response.created')
  expect(String(objs[0].response.id)).toMatch(/^resp_/)
  const added = objs.find((o) => o.type === 'response.output_item.added')
  expect(added.item.type).toBe('message')
  expect(added.item.role).toBe('assistant')
  const deltas = objs.filter((o) => o.type === 'response.output_text.delta').map((o) => o.delta)
  expect(deltas.join('')).toBe('你好')
  const done = objs.find((o) => o.type === 'response.output_item.done')
  expect(done.item.type).toBe('message')
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.status).toBe('completed')
  expect(completed.response.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
})

it('responsesToAnthropic 流式：tool_use 转函数调用事件', async () => {
  const events = await readStream(
    responsesToAnthropic.convertStream(
      sseStream(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_7","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北京\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const added = objs.find((o) => o.type === 'response.output_item.added')
  expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '' })
  const argDeltas = objs.filter((o) => o.type === 'response.function_call_arguments.delta').map((o) => o.delta)
  expect(argDeltas.join('')).toBe('{"city":"北京"}')
  const done = objs.find((o) => o.type === 'response.output_item.done')
  expect(done.item.type).toBe('function_call')
  expect(done.item.call_id).toBe('call_7')
})

// —— 修复回合：评审 C2/I1/I5 ——

// C2：多片段文本与工具参数累积，done/completed 完整；created id 为 resp_ 前缀
it('responsesToAnthropic 流式：多片段累积与 completed 输出完整', async () => {
  const events = await readStream(
    responsesToAnthropic.convertStream(
      sseStream(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_m","usage":{"input_tokens":9}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_8","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ci"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ty\\":\\"北京\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
      'gpt-5',
    ),
  )
  const objs = events.map((e) => JSON.parse(e.data))
  const dones = objs.filter((o) => o.type === 'response.output_item.done')
  expect(dones).toHaveLength(2)
  expect(dones[0].item.content).toEqual([{ type: 'output_text', text: '你好' }])
  expect(dones[1].item.arguments).toBe('{"city":"北京"}')
  const completed = objs.find((o) => o.type === 'response.completed')
  expect(completed.response.output).toHaveLength(2)
  expect(completed.response.usage).toEqual({ input_tokens: 9, output_tokens: 3, total_tokens: 12 })
  const created = objs.find((o) => o.type === 'response.created')
  expect(String(created.response.id)).toMatch(/^resp_/)
})

// I5：EasyInputMessage（无 type 字段）
it('responsesToAnthropic 请求：无 type 字段的 EasyInputMessage 不被丢弃', () => {
  const out = responsesToAnthropic.convertRequest(
    {
      model: 'claude-3-5',
      input: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
      ],
    },
    'claude-3-5',
  )
  expect(out.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
  ])
})
