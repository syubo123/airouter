// SSE（Server-Sent Events）解析与编码：流式转换的基础件

/** 一条 SSE 事件：event 字段（可选）与 data 载荷（多行 data 已按规范以 \n 拼接） */
export interface SseEvent {
  /** event 字段值（无则未设置） */
  event?: string
  /** data 载荷（多行已拼接） */
  data: string
}

/** 行终止符（含整行）匹配：\r\n、\r、\n 三种 */
const LINE_RE = /^[^\r\n]*(?:\r\n|\r|\n)/

/**
 * 解析字节流为 SSE 事件流（异步生成器）
 * 正确处理：chunk 任意切分（含多字节字符被劈开）、\r\n/\n/\r 换行、
 * 跨 chunk 的 \r\n、多行 data 拼接、注释与 id/retry 字段忽略、结尾半截事件 flush
 * @param stream 上游响应字节流
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  /** 行缓冲（可能含未完成的 \r） */
  let buf = ''
  /** 当前事件的 event 字段 */
  let event: string | undefined
  /** 当前事件的 data 行集合 */
  let dataLines: string[] = []
  /** 当前事件是否已出现字段（空行仅在事件有内容时产出） */
  let hasField = false
  /** 已完成待产出的事件 */
  const pending: SseEvent[] = []

  /**
   * 处理一行：事件完成时推入 pending
   * @param line 行内容（不含换行符）
   */
  const handleLine = (line: string): void => {
    if (line === '') {
      if (!hasField) return
      pending.push({ event, data: dataLines.join('\n') })
      event = undefined
      dataLines = []
      hasField = false
      return
    }
    if (line.startsWith(':')) return // 注释行
    hasField = true
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1) // 仅剥离一个空格
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    // id/retry 等字段忽略
  }

  /** 消费缓冲内全部完整行 */
  const drainAll = (): void => {
    for (;;) {
      const m = buf.match(LINE_RE)
      if (!m) return
      const line = m[0].replace(/\r\n|\r|\n$/, '')
      buf = buf.slice(m[0].length)
      handleLine(line)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    if (buf.endsWith('\r')) continue // 可能是跨 chunk 的 \r\n 前半，等下一 chunk
    drainAll()
    yield* pending.splice(0)
  }
  // 流结束：flush 解码器，消费剩余行（EOF 时孤 \r 也是行终止符）
  buf += decoder.decode()
  drainAll()
  if (buf.length > 0) {
    const rest = buf
    buf = ''
    handleLine(rest) // 无换行结尾的最后一行
  }
  if (hasField) {
    // 未以空行收尾的半截事件也产出
    pending.push({ event, data: dataLines.join('\n') })
  }
  yield* pending.splice(0)
}

/**
 * 编码一条 SSE 事件为规范字节（data 内部的换行拆成多条 data: 行）
 * @param ev 事件
 */
export function encodeSSE(ev: SseEvent): string {
  let out = ''
  if (ev.event !== undefined) out += `event: ${ev.event}\n`
  for (const line of ev.data.split('\n')) out += `data: ${line}\n`
  return out + '\n'
}
