// 全项目共享的数据类型（DB 行经解码后的内存表示）

/** 上游渠道 */
export interface Channel {
  /** 渠道 ID */
  id: number
  /** 渠道显示名称 */
  name: string
  /** 上游格式类型 */
  type: 'openai' | 'anthropic'
  /** 上游地址（如 https://api.example.com） */
  base_url: string
  /** 上游密钥 */
  api_key: string
  /** 支持的模型名列表（客户端侧名称） */
  models: string[]
  /** 改名映射：客户端模型名 → 上游模型名 */
  model_mapping: Record<string, string>
  /** 优先级，数字越小越先尝试 */
  priority: number
  /** 是否支持上游 /v1/responses 端点（仅 openai 类型有意义） */
  supports_responses: boolean
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
}

/** 网关自签发的 API key */
export interface ApiKeyRow {
  /** key ID */
  id: number
  /** 备注名 */
  name: string
  /** 完整密钥（sk- 前缀） */
  key: string
  /** 是否启用 */
  enabled: boolean
  /** 最后使用时间（从未使用为 null） */
  last_used_at: string | null
  /** 创建时间 */
  created_at: string
}

/** 失败调用日志 */
export interface FailureLogRow {
  /** 日志 ID */
  id: number
  /** 时间 */
  created_at: string
  /** 使用的 key 备注名 */
  api_key_name: string
  /** 尝试的渠道名（多次失败时为聚合值） */
  channel_name: string
  /** 请求的模型 */
  model: string
  /** 客户端格式与路径 */
  endpoint: string
  /** 最后一次上游 HTTP 状态 */
  status: number
  /** 错误原因摘要 */
  error: string
}
