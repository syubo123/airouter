// 网关渠道路由选择：按模型筛选启用渠道并排序
import type { Channel } from '../types'
import { rowToChannel } from '../admin/channels'

/** 渠道表 DB 行类型（与 admin/channels 内部一致，经结构化类型复用 rowToChannel） */
type ChannelDbRow = Parameters<typeof rowToChannel>[0]

/**
 * 查询可服务指定模型的渠道：enabled=1 且模型列表包含该模型，按 priority 升序、id 升序
 * @param db D1 数据库绑定
 * @param model 客户端请求的模型名（客户端侧名称）
 */
export async function selectChannels(db: D1Database, model: string): Promise<Channel[]> {
  const { results } = await db.prepare('SELECT * FROM channels WHERE enabled = 1 ORDER BY priority ASC, id ASC').all<ChannelDbRow>()
  const all = (results ?? []).map(rowToChannel)
  return all.filter((ch) => ch.models.includes(model))
}
