// Worker 入口：Hono 应用，挂载全部路由（后续任务逐步补充 /v1/*）
import { Hono } from 'hono'
import type { AppEnv } from './env'
import { adminAuthApi } from './admin/auth'
import { channelsApi } from './admin/channels'
import { keysApi } from './admin/keys'
import { logsApi, statsApi } from './admin/logs'
import { modelsApi } from './gateway/models'
import { registerGatewayRoutes } from './gateway/handler'

/** 应用实例（AppEnv 含 Workers 绑定与中间件变量） */
const app = new Hono<AppEnv>()

// 管理端认证 API（status/init/login/logout/me）
app.route('/admin/api', adminAuthApi)
// 渠道管理（含连通性测试）
app.route('/admin/api/channels', channelsApi)
// API key 管理
app.route('/admin/api/keys', keysApi)
// 失败日志与统计
app.route('/admin/api/logs', logsApi)
app.route('/admin/api/stats', statsApi)
// 网关：对话端点、响应查询与模型列表（key 鉴权）
registerGatewayRoutes(app)
app.route('/v1/models', modelsApi)

// 健康检查端点（部署后冒烟用）
app.get('/healthz', (c) => c.json({ status: 'ok' }))

export default app
