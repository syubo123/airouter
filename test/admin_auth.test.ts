// Task 3：管理端初始化/登录/会话的集成测试
import { SELF } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { resetDb } from './db'

// 每个测试前重置数据库
beforeEach(resetDb)

/** 测试用 Worker 地址 */
const base = 'https://example.com'

/** JSON POST 辅助 */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 执行管理员初始化 */
function initAdmin(): Promise<Response> {
  return post('/admin/api/init', { username: 'admin', password: 'secret123' })
}

// 未初始化时 status 应报告 initialized:false
it('未初始化时 status 返回 initialized:false', async () => {
  const res = await SELF.fetch(`${base}/admin/api/status`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ initialized: false })
})

// 初始化成功后 status 翻转；重复初始化被拒绝
it('init 设置管理员，status 翻转，重复初始化 409', async () => {
  const ok = await initAdmin()
  expect(ok.status).toBe(200)
  const dup = await initAdmin()
  expect(dup.status).toBe(409)
  const st = await SELF.fetch(`${base}/admin/api/status`)
  expect(await st.json()).toEqual({ initialized: true })
})

// 参数校验：空用户名或过短密码拒绝
it('init 参数校验：空用户名或短密码返回 400', async () => {
  expect((await post('/admin/api/init', { username: '', password: 'secret123' })).status).toBe(400)
  expect((await post('/admin/api/init', { username: 'admin', password: '123' })).status).toBe(400)
})

// 登录成功设置会话 cookie；受保护路由凭 cookie 可访问，无 cookie 401
it('登录设置会话 cookie，受保护路由凭 cookie 访问，无 cookie 401', async () => {
  await initAdmin()
  const login = await post('/admin/api/login', { username: 'admin', password: 'secret123' })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('admin_session=')
  const cookie = setCookie.split(';')[0]
  const me = await SELF.fetch(`${base}/admin/api/me`, { headers: { cookie } })
  expect(me.status).toBe(200)
  expect(await me.json()).toEqual({ username: 'admin' })
  const anon = await SELF.fetch(`${base}/admin/api/me`)
  expect(anon.status).toBe(401)
})

// 登录失败路径
it('错误用户名或密码登录 401', async () => {
  await initAdmin()
  expect((await post('/admin/api/login', { username: 'admin', password: 'wrong' })).status).toBe(401)
  expect((await post('/admin/api/login', { username: 'nobody', password: 'secret123' })).status).toBe(401)
})

// 登出后原 cookie 失效（服务端按过期 JWT 拒绝：登出把 cookie 置空）
it('logout 清除会话 cookie', async () => {
  await initAdmin()
  const login = await post('/admin/api/login', { username: 'admin', password: 'secret123' })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const out = await post('/admin/api/logout', {}, { cookie })
  expect(out.status).toBe(200)
  expect(out.headers.get('set-cookie') ?? '').toContain('admin_session=;')
})
