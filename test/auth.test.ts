// Task 2：密码哈希与 JWT 的单元测试
import { expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/worker/auth/password'
import { signJwt, verifyJwt } from '../src/worker/auth/jwt'

// 哈希应带随机盐：两次结果不同，且格式带算法与迭代次数前缀
it('hashPassword：两次哈希结果不同且格式为 pbkdf2:100000:盐:哈希', async () => {
  const a = await hashPassword('secret123')
  const b = await hashPassword('secret123')
  expect(a).not.toEqual(b)
  expect(a.startsWith('pbkdf2:100000:')).toBe(true)
  expect(a.split(':')).toHaveLength(4)
})

// 校验：正确密码通过，错误密码与非法存储串拒绝
it('verifyPassword：正确密码 true，错误密码与篡改存储串 false', async () => {
  const stored = await hashPassword('secret123')
  expect(await verifyPassword('secret123', stored)).toBe(true)
  expect(await verifyPassword('wrong', stored)).toBe(false)
  expect(await verifyPassword('secret123', 'pbkdf2:100000:xxxx:yyyy')).toBe(false)
  expect(await verifyPassword('secret123', 'not-a-valid-format')).toBe(false)
})

// 签发与还原：payload 完整往返
it('signJwt/verifyJwt：签发的令牌可还原 payload', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = await signJwt({ sub: 'admin', exp }, 'test-secret')
  const payload = await verifyJwt(token, 'test-secret')
  expect(payload?.sub).toBe('admin')
  expect(payload?.exp).toBe(exp)
})

// 拒绝路径：过期、换密钥签发、垃圾串
it('verifyJwt：过期、错误密钥、垃圾串均返回 null', async () => {
  const expired = await signJwt({ sub: 'admin', exp: Math.floor(Date.now() / 1000) - 10 }, 'test-secret')
  expect(await verifyJwt(expired, 'test-secret')).toBeNull()
  const wrongKey = await signJwt({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, 'other-secret')
  expect(await verifyJwt(wrongKey, 'test-secret')).toBeNull()
  expect(await verifyJwt('garbage.token.here', 'test-secret')).toBeNull()
})
