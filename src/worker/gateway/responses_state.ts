// Responses 有状态会话（网关自管 store / previous_response_id）
// 状态存 D1：续接时展开为完整 input 再发上游；响应 ID 由网关签发并改写

/** 会话状态保留条数上限 */
const KEEP_STATES = 1000

/** 随机字符集（base62） */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 生成网关响应 ID：resp_ + 24 位 base62 随机串
 */
export function newResponseId(): string {
  const len = 24
  const max = 248 // 62*4，256 内最大 62 倍数（拒绝采样避免模偏差）
  let out = ''
  const buf = new Uint8Array(len * 2)
  while (out.length < len) {
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < max) out += ALPHABET[b % 62]
      if (out.length === len) break
    }
  }
  return `resp_${out}`
}

/**
 * 读取会话状态
 * @param db D1 数据库绑定
 * @param id 网关响应 ID
 * @returns 会话 items；不存在返回 null
 */
export async function loadState(db: D1Database, id: string): Promise<{ items: unknown[] } | null> {
  const row = await db.prepare('SELECT items FROM responses_state WHERE response_id = ?').bind(id).first<{ items: string }>()
  if (!row) return null
  return { items: JSON.parse(row.items) as unknown[] }
}

/**
 * 保存会话状态并清理旧数据（保留最近 KEEP_STATES 条，按写入顺序）
 * @param db D1 数据库绑定
 * @param id 网关响应 ID
 * @param items 展开后的完整会话 items
 * @param responseJson 完整响应对象（含改写后的 id，供 GET 查询）
 */
export async function saveState(db: D1Database, id: string, items: unknown[], responseJson: string): Promise<void> {
  await db
    .prepare('INSERT INTO responses_state (response_id, items, response_json, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .bind(id, JSON.stringify(items), responseJson)
    .run()
  await db
    .prepare(
      'DELETE FROM responses_state WHERE rowid NOT IN (SELECT rowid FROM responses_state ORDER BY rowid DESC LIMIT ?)',
    )
    .bind(KEEP_STATES)
    .run()
}

/**
 * 读取完整响应对象（GET /v1/responses/:id 用）
 * @param db D1 数据库绑定
 * @param id 网关响应 ID
 */
export async function loadResponseJson(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare('SELECT response_json FROM responses_state WHERE response_id = ?').bind(id).first<{ response_json: string | null }>()
  return row?.response_json ?? null
}

/**
 * 续接展开：previous_response_id 存在且 prior 有值时，返回 prior + 本轮 input（字符串包装为 message item）
 * prior 为 null（ID 不存在）时原样返回，由调用方判 404
 * @param body 客户端请求体（input / previous_response_id 字段）
 * @param priorItems 已取出的前序 items（无则 null）
 */
export function expandInput(
  body: { input?: unknown; previous_response_id?: string },
  priorItems: unknown[] | null,
): { input: unknown } {
  if (!body.previous_response_id) return { input: body.input }
  if (!priorItems) return { input: body.input }
  const inputItems: unknown = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : (body.input ?? [])
  return { input: [...priorItems, ...(Array.isArray(inputItems) ? inputItems : [inputItems])] }
}

/**
 * 深度改写响应对象/事件里的旧 resp_ ID 为网关 ID：
 * 只动 key 为 id/response_id 且值以 resp_ 开头的字段；msg_/fc_/call_id 等其他 id 家族不动
 * 返回新对象，不修改原对象
 * @param obj 响应对象或 SSE 事件的 data 对象
 * @param newId 网关签发的新 ID
 */
export function rewriteResponseId(obj: unknown, newId: string): unknown {
  if (Array.isArray(obj)) {
    return obj.map((v) => rewriteResponseId(v, newId))
  }
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if ((k === 'id' || k === 'response_id') && typeof v === 'string' && v.startsWith('resp_')) {
        out[k] = newId
      } else {
        out[k] = rewriteResponseId(v, newId)
      }
    }
    return out
  }
  return obj
}
