// PBKDF2 密码哈希与校验（Workers Web Crypto 实现，无原生依赖）
import { fromB64Url, toB64Url } from '../util/b64'

/** 迭代次数（存储串中带此值，校验时按存储值执行） */
const ITERATIONS = 100000
/** 盐长度（字节） */
const SALT_BYTES = 16
/** 派生哈希长度（字节） */
const HASH_BYTES = 32

/**
 * PBKDF2-SHA256 派生
 * @param password 明文密码
 * @param salt 盐
 * @param iterations 迭代次数
 */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * 常量时间字节比较（防时序侧信道）
 * @param a 字节序列一
 * @param b 字节序列二
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * 哈希密码，返回存储串 "pbkdf2:<迭代>:<盐 b64url>:<哈希 b64url>"
 * @param password 明文密码
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2:${ITERATIONS}:${toB64Url(salt)}:${toB64Url(hash)}`
}

/**
 * 校验密码是否与存储串匹配（存储串格式非法一律返回 false，不抛错）
 * @param password 待验证明文密码
 * @param stored 存储串（hashPassword 的返回值格式）
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1) return false
  try {
    const salt = fromB64Url(parts[2])
    const expected = fromB64Url(parts[3])
    const actual = await derive(password, salt, iterations)
    return constantTimeEqual(actual, expected)
  } catch {
    return false
  }
}
