// Task 6：SSE 解析与编码测试（重点：chunk 边界、多字节字符、CRLF、多行 data）
import { expect, it } from 'vitest'
import { encodeSSE, parseSSE, type SseEvent } from '../src/worker/convert/sse'

/** 把字符串数组转为字节流（每个字符串一个 chunk） */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
  })
}

/** 把字节数组列表转为字节流（用于精确按字节切分） */
function byteStreamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++])
      else controller.close()
    },
  })
}

/** 收集流的全部事件 */
async function collect(chunks: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of parseSSE(streamOf(chunks))) out.push(ev)
  return out
}

// 一条事件被劈成三个 chunk 仍能完整还原
it('事件内容跨三个 chunk 断裂可还原', async () => {
  const events = await collect(['data: {"a', '": 1}', '\n\n'])
  expect(events).toEqual([{ data: '{"a": 1}' }])
})

// 中文多字节字符的 UTF-8 字节从中间劈开可还原（TextDecoder 流式解码）
it('中文多字节字符按字节劈开可还原', async () => {
  const full = new TextEncoder().encode('data: 中文内容\n\n')
  // 'data: ' 占 6 字节，'中' 占 3 字节，offset=7 把'中'从中间劈开
  const out: SseEvent[] = []
  for await (const ev of parseSSE(byteStreamOf([full.slice(0, 7), full.slice(7)]))) out.push(ev)
  expect(out).toEqual([{ data: '中文内容' }])
})

// 两个事件粘在一个 chunk 里能拆开
it('一个 chunk 内两条事件被正确拆分', async () => {
  const events = await collect(['data: a\n\ndata: b\n\n'])
  expect(events).toEqual([{ data: 'a' }, { data: 'b' }])
})

// CRLF 与孤 CR 换行均按行分隔处理；\r 结尾跨 chunk 的 \r\n 不误判为两次换行
it('CRLF、孤 CR、跨 chunk 的 CRLF 均正确处理', async () => {
  expect(await collect(['data: x\r\n\r\n'])).toEqual([{ data: 'x' }])
  expect(await collect(['data: y\r\r'])).toEqual([{ data: 'y' }])
  const events = await collect(['data: z\r', '\n\r\n'])
  expect(events).toEqual([{ data: 'z' }])
})

// 多行 data 按 SSE 规范以 \n 拼接
it('多行 data 以换行拼接', async () => {
  const events = await collect(['data: line1\ndata: line2\n\n'])
  expect(events).toEqual([{ data: 'line1\nline2' }])
})

// event 字段保留，注释与 id/retry 字段忽略
it('event 字段保留，注释与 id/retry 忽略', async () => {
  const events = await collect([': keep-alive\nevent: message.delta\nid: 7\ndata: {"x":1}\n\n'])
  expect(events).toEqual([{ event: 'message.delta', data: '{"x":1}' }])
})

// 流结束时没有空行收尾的半截事件也要 flush
it('结尾无空行的半截事件在流结束时 flush', async () => {
  const events = await collect(['data: tail'])
  expect(events).toEqual([{ data: 'tail' }])
})

// data 值里冒号后仅剥离第一个空格，后续空格保留
it('data 值中冒号后仅剥离首个空格', async () => {
  const events = await collect(['data: 两个空格  保留\n\n'])
  expect(events).toEqual([{ data: '两个空格  保留' }])
})

// encodeSSE：data 内换行拆成多条 data: 行，event 字段前置
it('encodeSSE 输出规范字节流', () => {
  expect(encodeSSE({ data: 'a' })).toBe('data: a\n\n')
  expect(encodeSSE({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n')
  expect(encodeSSE({ event: 'x', data: 'y' })).toBe('event: x\ndata: y\n\n')
})
