// 测试环境类型增强：给 cloudflare:test 的 env 提供 D1 绑定类型、给 inject 提供迁移列表类型
declare global {
  namespace Cloudflare {
    /** 测试环境绑定（与 wrangler.jsonc 一致） */
    interface Env {
      /** D1 数据库绑定 */
      DB: D1Database
    }
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    /** global-setup 读取的 D1 迁移列表 */
    migrations: { name: string; queries: string[] }[]
  }
}

export {}
