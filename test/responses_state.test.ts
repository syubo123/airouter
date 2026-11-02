// Task 10：Responses 有状态会话模块测试
import { env } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { resetDb } from './db'
import { expandInput, loadState, newResponseId, rewriteResponseId, saveState } from '../src/worker/gateway/responses_state'

// 每个测试前重置数据库
beforeEach(resetDb)

// 生成的响应 ID：resp_ 前缀、长度 29、两次不同
it('newResponseId：resp_ 前缀且随机', () => {
  const a = newResponseId()
  const b = newResponseId()
  expect(a).toMatch(/^resp_[A-Za-z0-9]{24}$/)
  expect(b).toMatch(/^resp_[A-Za-z0-9]{24}$/)
  expect(a).not.toBe(b)
})

// 存取往返
it('saveState 后 loadState 还原 items', async () => {
  const items = [{ type: 'message', role: 'user', content: '你好' }, { type: 'message', role: 'assistant', content: '在的' }]
  await saveState(env.DB, 'resp_x', items, '{"id":"resp_x"}')
  const loaded = await loadState(env.DB, 'resp_x')
  expect(loaded?.items).toEqual(items)
  expect(await loadState(env.DB, 'resp_missing')).toBeNull()
})

// 写入后清理，保留最近 1000 条
it('saveState 清理只保留最近 1000 条', async () => {
  for (let i = 0; i < 1005; i++) {
    await env.DB.prepare('INSERT INTO responses_state (response_id, items) VALUES (?, ?)').bind(`resp_old_${i}`, '[]').run()
  }
  await saveState(env.DB, 'resp_new', [], '{"id":"resp_new"}')
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM responses_state').all<{ n: number }>()
  expect(results![0].n).toBeLessThanOrEqual(1000)
  // 最新一条仍在
  expect(await loadState(env.DB, 'resp_new')).not.toBeNull()
})

// expandInput：拼接顺序 prior 在前、字符串 input 包装、无 previous_response_id 原样返回
it('expandInput：续接展开与字符串包装', () => {
  const prior = [{ type: 'message', role: 'user', content: '第一轮' }]
  const r1 = expandInput({ input: [{ type: 'message', role: 'user', content: '第二轮' }], previous_response_id: 'resp_x' }, prior)
  expect(r1.input).toEqual([
    { type: 'message', role: 'user', content: '第一轮' },
    { type: 'message', role: 'user', content: '第二轮' },
  ])
  // input 为字符串时包装为 message item
  const r2 = expandInput({ input: '第二轮', previous_response_id: 'resp_x' }, prior)
  expect(r2.input).toEqual([
    { type: 'message', role: 'user', content: '第一轮' },
    { type: 'message', role: 'user', content: '第二轮' },
  ])
  // prior 为 null（ID 不存在）：原样返回，由调用方判 404
  const r3 = expandInput({ input: '你好', previous_response_id: 'resp_missing' }, null)
  expect(r3.input).toEqual('你好')
  // 无 previous_response_id：原样返回（字符串不包装）
  const r4 = expandInput({ input: '你好' }, null)
  expect(r4.input).toBe('你好')
})

// rewriteResponseId：改写响应对象与事件中的 resp_ id；msg_/fc_/call_id 不动；不改原对象
it('rewriteResponseId：改写 resp_ id，其余 id 家族不动', () => {
  const resp = {
    id: 'resp_upstream',
    output: [
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'f', arguments: '{}' },
    ],
  }
  const out = rewriteResponseId(resp, 'resp_gateway') as typeof resp
  expect(out.id).toBe('resp_gateway')
  expect(out.output[0].id).toBe('msg_1')
  expect(out.output[1].id).toBe('fc_1')
  expect(out.output[1].call_id).toBe('call_9')
  // 原对象不被修改
  expect(resp.id).toBe('resp_upstream')

  const event = { type: 'response.created', response: { id: 'resp_upstream' } }
  const ev2 = rewriteResponseId(event, 'resp_gateway') as typeof event
  expect(ev2.response.id).toBe('resp_gateway')

  const itemEvent = { type: 'response.output_item.added', response_id: 'resp_upstream', item: { id: 'fc_2' } }
  const ev3 = rewriteResponseId(itemEvent, 'resp_gateway') as typeof itemEvent
  expect(ev3.response_id).toBe('resp_gateway')
  expect(ev3.item.id).toBe('fc_2')
})
