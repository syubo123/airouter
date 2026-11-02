// Cloudflare Workers 环境绑定定义（全项目 Hono 泛型使用）
export interface Env {
  /** D1 数据库绑定（承载全部持久数据：渠道、key、日志、会话状态） */
  DB: D1Database
}

/** Hono 应用环境类型：Workers 绑定 + 中间件注入的变量（adminAuth 写入 adminUser） */
export type AppEnv = {
  /** Cloudflare 环境绑定 */
  Bindings: Env
  /** 请求上下文变量 */
  Variables: {
    /** 当前登录管理员用户名（adminAuth 中间件注入） */
    adminUser: string
    /** 当前调用方 API key 的备注名（keyAuth 中间件注入） */
    keyName: string
  }
}
