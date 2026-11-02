// 上游状态分类与客户端格式错误体
import type { ClientFormat } from './upstream'

/**
 * 上游 HTTP 状态分类：
 * - failover：应换下一个渠道重试（408/425/429/5xx）
 * - skip：该渠道鉴权失效，跳过换下一个（401/403）
 * - fatal：请求本身问题，换个渠道也一样，直接返回（400/402/404/413/415/422 等）
 * @param status 上游 HTTP 状态码
 */
export function classifyStatus(status: number): 'failover' | 'skip' | 'fatal' {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'failover'
  if (status === 401 || status === 403) return 'skip'
  return 'fatal'
}

/**
 * 构造按客户端格式的错误响应体（OpenAI 风格 / Anthropic 风格 / Responses 风格同 OpenAI）
 * @param fmt 客户端格式
 * @param message 错误信息
 */
export function errorBodyFor(fmt: ClientFormat, message: string): Record<string, unknown> {
  if (fmt === 'anthropic') {
    return { type: 'error', error: { type: 'api_error', message } }
  }
  return { error: { message, type: 'api_error', code: 'upstream_error' } }
}

/**
 * 构造客户端格式的 4xx 参数错误体
 * @param fmt 客户端格式
 * @param message 错误信息
 */
export function invalidRequestBodyFor(fmt: ClientFormat, message: string): Record<string, unknown> {
  if (fmt === 'anthropic') {
    return { type: 'error', error: { type: 'invalid_request_error', message } }
  }
  return { error: { message, type: 'invalid_request_error' } }
}
