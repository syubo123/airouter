// 管理端认证：初始化、登录、登出、会话校验中间件
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../env'
import {
  getSetting,
  isInitialized,
  KEY_ADMIN_PASSWORD_HASH,
  KEY_ADMIN_USERNAME,
  KEY_SESSION_SECRET,
  setSetting,
} from '../db/settings'
import { hashPassword, verifyPassword } from '../auth/password'
import { signJwt, verifyJwt } from '../auth/jwt'
import { toB64Url } from '../util/b64'

/** 会话 cookie 名 */
const SESSION_COOKIE = 'admin_session'
/** 会话有效期（秒）：7 天 */
const SESSION_TTL = 7 * 24 * 3600

/**
 * 生成随机会话密钥（32 字节，base64url 编码）
 */
function generateSessionSecret(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * 管理员会话校验中间件：校验 admin_session cookie 内的 JWT，失败 401
 * 挂在除 status/init/login 外的全部 /admin/api/* 路由
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const secret = await getSetting(c.env.DB, KEY_SESSION_SECRET)
  const token = getCookie(c, SESSION_COOKIE)
  if (!secret || !token) return c.json({ error: '未登录' }, 401)
  const payload = await verifyJwt(token, secret)
  if (!payload) return c.json({ error: '未登录' }, 401)
  c.set('adminUser', payload.sub)
  await next()
})

/** 管理端认证子应用（挂载于 /admin/api） */
export const adminAuthApi = new Hono<AppEnv>()

// 初始化状态查询（无需登录）
adminAuthApi.get('/status', async (c) => {
  return c.json({ initialized: await isInitialized(c.env.DB) })
})

// 首次初始化：设置管理员用户名密码与会话密钥
adminAuthApi.post('/init', async (c) => {
  if (await isInitialized(c.env.DB)) return c.json({ error: '已初始化，不可重复操作' }, 409)
  const body = await c.req
    .json<{ username?: unknown; password?: unknown }>()
    .catch(() => ({ username: undefined, password: undefined }))
  const username = body.username
  const password = body.password
  if (typeof username !== 'string' || username.length < 1 || username.length > 64) {
    return c.json({ error: '用户名必须为 1-64 个字符' }, 400)
  }
  if (typeof password !== 'string' || password.length < 6) {
    return c.json({ error: '密码至少 6 位' }, 400)
  }
  await setSetting(c.env.DB, KEY_ADMIN_USERNAME, username)
  await setSetting(c.env.DB, KEY_ADMIN_PASSWORD_HASH, await hashPassword(password))
  await setSetting(c.env.DB, KEY_SESSION_SECRET, generateSessionSecret())
  return c.json({ ok: true })
})

// 登录：校验账密并签发会话 cookie
adminAuthApi.post('/login', async (c) => {
  const body = await c.req
    .json<{ username?: unknown; password?: unknown }>()
    .catch(() => ({ username: undefined, password: undefined }))
  const username = body.username
  const password = body.password
  const storedUser = await getSetting(c.env.DB, KEY_ADMIN_USERNAME)
  const storedHash = await getSetting(c.env.DB, KEY_ADMIN_PASSWORD_HASH)
  if (typeof username !== 'string' || typeof password !== 'string' || !storedUser || !storedHash) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  if (username !== storedUser || !(await verifyPassword(password, storedHash))) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  const secret = await getSetting(c.env.DB, KEY_SESSION_SECRET)
  if (!secret) return c.json({ error: '服务端会话密钥缺失，请重新初始化' }, 500)
  const token = await signJwt({ sub: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, secret)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, // 仅服务端可读
    secure: true, // 仅 HTTPS 传输
    sameSite: 'Lax', // 防 CSRF
    path: '/',
    maxAge: SESSION_TTL,
  })
  return c.json({ ok: true })
})

// 登出：清除会话 cookie
adminAuthApi.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// 会话探针（受 adminAuth 保护，前端用于检查登录态）
adminAuthApi.get('/me', adminAuth, (c) => {
  return c.json({ username: c.get('adminUser') })
})
