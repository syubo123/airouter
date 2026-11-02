// 转换器公共接口与流式辅助

/** 一对转换器：把客户端格式与上游格式互相转换（请求/非流式响应/流式响应） */
export interface ConvPair {
  /** 转换客户端请求体为上游请求体（model 为改名映射后的上游模型名） */
  convertRequest(body: any, model: string): any
  /** 转换上游非流式响应体为客户端格式响应体 */
  convertResponse(upstreamBody: any, model: string): any
  /** 转换上游 SSE 字节流为客户端格式 SSE 字节流（上游中断时优雅收尾） */
  convertStream(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array>
}

/**
 * 把逐段产出 SSE 文本的异步生成器包装为字节流
 * @param gen 产出已编码 SSE 文本段的生成器
 */
export function sseStreamFromGenerator(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(enc.encode(value))
      }
    },
  })
}

/**
 * 宽松 JSON 解析：解析失败返回 undefined（转换器对上游畸形数据不抛错）
 * @param s 待解析字符串
 */
export function tryParseJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * 把逐段产出原始字节的异步生成器包装为字节流
 * @param gen 产出 Uint8Array 的生成器
 */
export function bytesStreamFromGenerator(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
  })
}

/**
 * 优雅字节流：上游读取出错（连接中断）时安静结束而不是向客户端传播错误
 * @param stream 上游字节流
 */
export async function* gracefulBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  for (;;) {
    try {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    } catch {
      // 上游中断：直接结束，让下游的收尾逻辑（转换器/包装器）优雅补全
      return
    }
  }
}
