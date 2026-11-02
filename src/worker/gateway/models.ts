// /v1/models：聚合所有启用渠道的模型并集（OpenAI 格式响应）
import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { keyAuth } from './keyauth'

/** 模型列表子应用（挂载于 /v1/models） */
export const modelsApi = new Hono<AppEnv>()

// 需要 API key
modelsApi.use('*', keyAuth)

// 模型并集列表
modelsApi.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT models FROM channels WHERE enabled = 1').all<{ models: string }>()
  const ids = new Set<string>()
  for (const r of results ?? []) {
    for (const m of JSON.parse(r.models) as string[]) ids.add(m)
  }
  return c.json({
    object: 'list',
    data: [...ids].sort().map((id) => ({ id, object: 'model' })),
  })
})
