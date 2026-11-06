// 透传判定、上游端点选择与鉴权头组装
import type { Channel } from '../types'
import type { ConvPair } from '../convert/types'
import { chatToAnthropic, anthropicToChat } from '../convert/chat_anthropic'
import { responsesToAnthropic, anthropicToResponses } from '../convert/responses_anthropic'
import { chatToResponses, responsesToChat } from '../convert/chat_responses'

/** 客户端请求格式 */
export type ClientFormat = 'openai-chat' | 'openai-responses' | 'anthropic'

/**
 * 选择转换器：客户端格式 × 渠道能力 → 转换器或 null（null = 端点一致，透传）
 * 透传判定按"端点"而非"格式家族"：
 * - chat 客户端 + openai 渠道 → 透传
 * - anthropic 客户端 + anthropic 渠道 → 透传
 * - R 客户端 + openai 渠道（supports_responses 开）→ 透传；关 → 转 chat
 * - 其余组合两两互转
 * @param clientFmt 客户端格式
 * @param ch 目标渠道
 */
export function pickPair(clientFmt: ClientFormat, ch: Channel): ConvPair | null {
  if (clientFmt === 'openai-chat') {
    if (ch.type === 'openai') return null
    return chatToAnthropic
  }
  if (clientFmt === 'anthropic') {
    if (ch.type === 'anthropic') return null
    return ch.supports_responses ? anthropicToResponses : anthropicToChat
  }
  // openai-responses
  if (ch.type === 'anthropic') return responsesToAnthropic
  return ch.supports_responses ? null : responsesToChat
}

/**
 * 判断 base_url 是否带了路径（如智谱的 /api/paas/v4）：
 * 带路径 → 拼接时只加方法路径；纯域名 → 补 /v1 版本前缀
 * @param base_url 渠道上游地址
 */
function hasPath(base_url: string): boolean {
  try {
    const p = new URL(base_url).pathname
    return p !== '' && p !== '/'
  } catch {
    return false
  }
}

/**
 * 上游方法路径（按渠道 base_url 形态自动适配版本前缀）：
 * - 纯域名：/v1/chat/completions 等（OpenAI 式中转站）
 * - 带路径：/chat/completions 等（智谱 /api/paas/v4 式厂商）
 * @param base_url 渠道上游地址
 * @param kind 方法类别
 */
export function upstreamMethodPath(base_url: string, kind: 'chat' | 'responses' | 'messages'): string {
  const method = kind === 'chat' ? '/chat/completions' : kind === 'responses' ? '/responses' : '/messages'
  return `${hasPath(base_url) ? '' : '/v1'}${method}`
}

/**
 * 上游端点路径（与 pickPair 的判定配套；按 base_url 形态自动适配版本前缀）
 * @param clientFmt 客户端格式
 * @param ch 目标渠道
 */
export function pickUpstreamPath(clientFmt: ClientFormat, ch: Channel): string {
  const kind: 'chat' | 'responses' | 'messages' = ch.type === 'anthropic' ? 'messages' : clientFmt === 'openai-chat' ? 'chat' : ch.supports_responses ? 'responses' : 'chat'
  return upstreamMethodPath(ch.base_url, kind)
}

/**
 * 组装上游请求头（按渠道类型给鉴权）
 * @param ch 目标渠道
 */
export function upstreamHeaders(ch: Channel): Record<string, string> {
  if (ch.type === 'openai') {
    return { 'content-type': 'application/json', Authorization: `Bearer ${ch.api_key}` }
  }
  return { 'content-type': 'application/json', 'x-api-key': ch.api_key, 'anthropic-version': '2023-06-01' }
}
