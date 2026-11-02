// 测试辅助：应用 D1 迁移并清空业务数据（每个测试前调用，保证测试间隔离）
import { applyD1Migrations, env } from 'cloudflare:test'
import { inject } from 'vitest'

/** 需要清空的业务表（迁移建表后清数据） */
const TABLES = ['settings', 'channels', 'api_keys', 'failure_logs', 'responses_state'] as const

/**
 * 应用迁移（幂等）并清空全部业务表
 */
export async function resetDb(): Promise<void> {
  const migrations = inject('migrations') as { name: string; queries: string[] }[]
  await applyD1Migrations(env.DB, migrations)
  for (const t of TABLES) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
}
