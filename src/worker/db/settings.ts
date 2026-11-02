// settings 键值表读写（管理员凭据、会话密钥等配置的持久化）

/** 配置键名：管理员用户名 */
export const KEY_ADMIN_USERNAME = 'admin_username'
/** 配置键名：管理员密码哈希存储串 */
export const KEY_ADMIN_PASSWORD_HASH = 'admin_password_hash'
/** 配置键名：会话签名密钥（base64url） */
export const KEY_SESSION_SECRET = 'session_secret'

/**
 * 读取配置值
 * @param db D1 数据库绑定
 * @param key 配置键名
 * @returns 配置值；不存在返回 null
 */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

/**
 * 写入配置值（不存在则插入，存在则覆盖）
 * @param db D1 数据库绑定
 * @param key 配置键名
 * @param value 配置值
 */
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run()
}

/**
 * 是否已完成管理员初始化（存在密码哈希即视为已初始化）
 * @param db D1 数据库绑定
 */
export async function isInitialized(db: D1Database): Promise<boolean> {
  return (await getSetting(db, KEY_ADMIN_PASSWORD_HASH)) !== null
}
