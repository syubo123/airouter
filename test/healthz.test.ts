// 冒烟测试：验证 Worker 基础链路（vitest-pool-workers + wrangler 配置 + D1 迁移 + Hono 路由）
import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

// 健康检查端点应返回 200 与 status ok
it('GET /healthz 返回 status ok', async () => {
  const res = await SELF.fetch('https://example.com/healthz')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})
