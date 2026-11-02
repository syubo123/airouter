// HS256 JWT 签发与校验（Web Crypto HMAC 实现）
import { fromB64Url, toB64Url } from '../util/b64'

/** 会话载荷：sub 为主体（管理员用户名），exp 为过期时间（Unix 秒） */
export interface SessionPayload {
  /** 主体标识 */
  sub: string
  /** 过期时间（Unix 秒） */
  exp: number
}

/**
 * 导入 HMAC 签名密钥
 * @param secret 会话密钥
 */
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * 签发 JWT（header.payload.signature，base64url 编码）
 * @param payload 会话载荷
 * @param secret 签名密钥
 */
export async function signJwt(payload: SessionPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const h = toB64Url(new TextEncoder().encode(JSON.stringify(header)))
  const p = toB64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)))
  return `${h}.${p}.${toB64Url(sig)}`
}

/**
 * 校验签名与有效期并还原载荷；任何失败（格式/签名/过期/字段非法）返回 null，不抛错
 * @param token JWT 字符串
 * @param secret 签名密钥
 */
export async function verifyJwt(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  try {
    const key = await hmacKey(secret)
    const ok = await crypto.subtle.verify('HMAC', key, fromB64Url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`))
    if (!ok) return null
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(p))) as SessionPayload
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
