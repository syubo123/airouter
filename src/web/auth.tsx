// 路由守卫：未初始化跳 /init，未登录跳 /login
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { getStatus } from './api'

/**
 * 需登录的路由守卫组件
 * @param children 登录后渲染的子元素
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  /** 守卫状态：检查中 / 已登录 / 未初始化 / 未登录 */
  const [state, setState] = useState<'loading' | 'ok' | 'init' | 'login'>('loading')

  useEffect(() => {
    fetch('/admin/api/me', { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.ok) {
          setState('ok')
          return
        }
        const st = await getStatus().catch(() => null)
        setState(st && !st.initialized ? 'init' : 'login')
      })
      .catch(() => setState('login'))
  }, [])

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Spin size="large" />
      </div>
    )
  }
  if (state === 'init') return <Navigate to="/init" replace />
  if (state === 'login') return <Navigate to="/login" replace />
  return <>{children}</>
}
