// 管理 API 客户端：统一 fetch 封装、401 抛未登录错误（由路由守卫跳登录页）
import type { ApiKeyRow, Channel, FailureLogRow } from '../worker/types'

/** 未登录错误（路由守卫捕获后跳转登录页） */
export class UnauthorizedError extends Error {
  constructor() {
    super('未登录')
    this.name = 'UnauthorizedError'
  }
}

/**
 * 发起管理 API 请求：401 抛 UnauthorizedError；其他非 2xx 抛带后端错误信息的 Error
 * @param path 请求路径
 * @param method HTTP 方法
 * @param body 可选 JSON 请求体
 */
async function req(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) {
    const msg = await res
      .json()
      .then((b) => String((b as Record<string, unknown>).error ?? `请求失败（${res.status}）`))
      .catch(() => `请求失败（${res.status}）`)
    throw new Error(msg)
  }
  return res
}

/** GET 并解析 JSON */
async function get<T>(path: string): Promise<T> {
  return (await req(path)).json() as Promise<T>
}

/** 发送 JSON 并解析 JSON 响应 */
async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return (await req(path, method, body)).json() as Promise<T>
}

// —— 认证 ——

/** 查询初始化状态 */
export function getStatus(): Promise<{ initialized: boolean }> {
  return get('/admin/api/status')
}

/** 首次初始化管理员 */
export function init(username: string, password: string): Promise<{ ok: boolean }> {
  return send('/admin/api/init', 'POST', { username, password })
}

/**
 * 登录（错误凭据的 401 需在页面就地提示，不走 UnauthorizedError）
 */
export async function login(username: string, password: string): Promise<{ ok: boolean }> {
  const res = await fetch('/admin/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new Error(String(b.error ?? '登录失败'))
  }
  return res.json() as Promise<{ ok: boolean }>
}

/** 登出 */
export function logout(): Promise<{ ok: boolean }> {
  return send('/admin/api/logout', 'POST', {})
}

// —— 渠道 ——

/** 渠道编辑表单载荷（不含只读字段） */
export type ChannelForm = Omit<Channel, 'id' | 'created_at' | 'updated_at'>

/** 渠道列表 */
export function listChannels(): Promise<Channel[]> {
  return get('/admin/api/channels')
}

/** 新建渠道 */
export function createChannel(ch: ChannelForm): Promise<Channel> {
  return send('/admin/api/channels', 'POST', ch)
}

/** 更新渠道 */
export function updateChannel(id: number, ch: ChannelForm): Promise<Channel> {
  return send(`/admin/api/channels/${id}`, 'PUT', ch)
}

/** 删除渠道 */
export function deleteChannel(id: number): Promise<{ ok: boolean }> {
  return send(`/admin/api/channels/${id}`, 'DELETE')
}

/** 连通性测试结果 */
export interface TestResult {
  /** 是否成功 */
  ok: boolean
  /** 上游 HTTP 状态 */
  status: number
  /** 耗时（毫秒） */
  elapsed_ms: number
  /** 失败时的错误摘要 */
  error?: string
  /** 实际请求的上游 URL（失败时用于排查） */
  url?: string
}

/** 渠道连通性测试 */
export function testChannel(id: number): Promise<TestResult> {
  return send(`/admin/api/channels/${id}/test`, 'POST')
}

/** 拉取上游模型列表的入参 */
export interface FetchModelsPayload {
  /** 上游类型 */
  type: 'openai' | 'anthropic'
  /** 上游地址 */
  base_url: string
  /** 上游密钥 */
  api_key: string
}

/** 拉取上游模型列表的结果 */
export interface FetchModelsResult {
  /** 是否成功 */
  ok: boolean
  /** 模型名列表（成功时） */
  models?: string[]
  /** 上游 HTTP 状态（失败时） */
  status?: number
  /** 错误摘要（失败时） */
  error?: string
  /** 实际请求的上游 URL（失败时用于排查） */
  url?: string
}

/** 从上游拉取可用模型列表（未保存的草稿渠道也可以，直接传表单里的地址与密钥） */
export function fetchChannelModels(payload: FetchModelsPayload): Promise<FetchModelsResult> {
  return send('/admin/api/channels/fetch-models', 'POST', payload)
}

// —— API key ——

/** key 列表 */
export function listKeys(): Promise<ApiKeyRow[]> {
  return get('/admin/api/keys')
}

/** 新建 key（返回含完整密钥） */
export function createKey(name: string): Promise<ApiKeyRow> {
  return send('/admin/api/keys', 'POST', { name })
}

/** 修改 key（备注名 / 启用状态） */
export function toggleKey(id: number, enabled: boolean): Promise<ApiKeyRow> {
  return send(`/admin/api/keys/${id}`, 'PATCH', { enabled })
}

/** 删除 key */
export function deleteKey(id: number): Promise<{ ok: boolean }> {
  return send(`/admin/api/keys/${id}`, 'DELETE')
}

// —— 日志与统计 ——

/** 失败日志列表 */
export function listLogs(limit = 100): Promise<FailureLogRow[]> {
  return get(`/admin/api/logs?limit=${limit}`)
}

/** 清空失败日志 */
export function clearLogs(): Promise<{ ok: boolean }> {
  return send('/admin/api/logs', 'DELETE')
}

/** 仪表盘统计 */
export function getStats(): Promise<{ channels: number; keys: number; failures_today: number }> {
  return get('/admin/api/stats')
}
