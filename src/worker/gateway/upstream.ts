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
 * 上游端点路径（与 pickPair 的判定配套）
 * @param clientFmt 客户端格式
 * @param ch 目标渠道
 */
export function pickUpstreamPath(clientFmt: ClientFormat, ch: Channel): string {
  if (ch.type === 'anthropic') return '/v1/messages'
  if (clientFmt === 'openai-chat') return '/v1/chat/completions'
  return ch.supports_responses ? '/v1/responses' : '/v1/chat/completions'
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
