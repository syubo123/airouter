// 出站 fetch 模拟：测试内替换 globalThis.fetch
// （@cloudflare/vitest-plugin 中 SELF 与被测 Worker 同 isolate，全局替换对 Worker 的出站请求同样生效）
export interface RecordedCall {
  /** 请求 URL */
  url: string
  /** 请求初始化参数（含 method/headers/body） */
  init?: RequestInit
}

/** fetch 桩句柄 */
export interface StubHandle {
  /** 已记录的出站调用 */
  calls: RecordedCall[]
  /** 恢复真实 fetch */
  restore(): void
}

/** 路由响应器：匹配则返回 Response，否则返回 null 交给下一条 */
export type Responder = (url: URL, init?: RequestInit) => Response | null

/**
 * 安装 fetch 桩：按顺序匹配路由响应器，未匹配返回 500
 * @param routes 路由响应器列表
 */
export function stubFetch(routes: Responder[]): StubHandle {
  const real = globalThis.fetch
  const calls: RecordedCall[] = []
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url: rawUrl, init })
    const u = new URL(rawUrl)
    for (const r of routes) {
      const resp = r(u, init)
      if (resp) return resp
    }
    return new Response(JSON.stringify({ error: { message: `fetchstub: 未匹配路由 ${rawUrl}` } }), { status: 500 })
  }
  globalThis.fetch = fake as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}
