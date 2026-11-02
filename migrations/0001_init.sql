-- 初始建表迁移：五张表，字段与设计文档第八节一一对应
-- 每列注释说明字段用途（SQLite 无列注释语法，用行注释）

-- settings：键值配置表（管理员凭据、会话密钥等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,             -- 配置项名（如 admin_username / admin_password_hash / session_secret）
  value TEXT NOT NULL               -- 配置值
);

-- channels：上游渠道表
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,                        -- 渠道 ID，自增
  name TEXT NOT NULL,                                          -- 渠道显示名称
  type TEXT NOT NULL CHECK (type IN ('openai', 'anthropic')),  -- 上游格式类型
  base_url TEXT NOT NULL,                                      -- 上游地址（如 https://api.example.com）
  api_key TEXT NOT NULL DEFAULT '',                            -- 上游密钥
  models TEXT NOT NULL DEFAULT '[]',                           -- 支持的模型名列表（JSON 数组，客户端侧名称）
  model_mapping TEXT NOT NULL DEFAULT '{}',                    -- 改名映射（JSON 对象：客户端模型名 → 上游模型名）
  priority INTEGER NOT NULL DEFAULT 0,                         -- 优先级，数字越小越先尝试
  supports_responses INTEGER NOT NULL DEFAULT 0,               -- 是否支持上游 /v1/responses 端点（1/0，仅 openai 类型有意义）
  enabled INTEGER NOT NULL DEFAULT 1,                          -- 是否启用（1/0）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),          -- 创建时间
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))           -- 更新时间
);
CREATE INDEX IF NOT EXISTS idx_channels_priority ON channels(priority);

-- api_keys：网关自签发的调用密钥表
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,               -- key ID，自增
  name TEXT NOT NULL,                                 -- 备注名
  key TEXT NOT NULL UNIQUE,                           -- 完整密钥（sk- 前缀）
  enabled INTEGER NOT NULL DEFAULT 1,                 -- 是否启用（1/0）
  last_used_at TEXT,                                  -- 最后使用时间
  created_at TEXT NOT NULL DEFAULT (datetime('now'))  -- 创建时间
);

-- failure_logs：失败调用日志表（只记失败，保留最近 500 条）
CREATE TABLE IF NOT EXISTS failure_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,               -- 日志 ID，自增
  created_at TEXT NOT NULL DEFAULT (datetime('now')), -- 时间
  api_key_name TEXT NOT NULL DEFAULT '',              -- 使用的 key 备注名
  channel_name TEXT NOT NULL DEFAULT '',              -- 尝试的渠道名（多次失败时为聚合值）
  model TEXT NOT NULL DEFAULT '',                     -- 请求的模型
  endpoint TEXT NOT NULL DEFAULT '',                  -- 客户端格式与路径（如 openai /v1/chat/completions）
  status INTEGER NOT NULL DEFAULT 0,                  -- 最后一次上游 HTTP 状态
  error TEXT NOT NULL DEFAULT ''                      -- 错误原因摘要
);
CREATE INDEX IF NOT EXISTS idx_failure_logs_created ON failure_logs(created_at);

-- responses_state：Responses 有状态会话表（网关自管 store / previous_response_id，保留最近 1000 条）
CREATE TABLE IF NOT EXISTS responses_state (
  response_id TEXT PRIMARY KEY,                       -- 网关签发的响应 ID（resp_ 前缀）
  items TEXT NOT NULL,                                -- 展开后的完整会话 items（JSON 数组，供续接）
  response_json TEXT,                                 -- 完整响应对象（含改写后的 id，供 GET 查询）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))  -- 创建时间
);
CREATE INDEX IF NOT EXISTS idx_responses_state_created ON responses_state(created_at);
