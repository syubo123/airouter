// 登录页：管理员账号密码登录
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Button, Card, Form, Input, message } from 'antd'
import { getStatus, login } from '../api'

/** 登录表单值 */
interface LoginFormValues {
  /** 用户名 */
  username: string
  /** 密码 */
  password: string
}

/**
 * 登录页组件：未初始化时自动跳初始化页
 */
export default function LoginPage() {
  const navigate = useNavigate()
  /** 页面状态：检查中 / 未初始化 / 已初始化 */
  const [state, setState] = useState<'loading' | 'fresh' | 'ready'>('loading')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getStatus()
      .then((st) => setState(st.initialized ? 'ready' : 'fresh'))
      .catch(() => setState('ready'))
  }, [])

  if (state === 'loading') return null
  if (state === 'fresh') return <Navigate to="/init" replace />

  /** 提交登录 */
  const onSubmit = async (values: LoginFormValues) => {
    setSubmitting(true)
    try {
      await login(values.username, values.password)
      message.success('登录成功')
      navigate('/')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f5f5f5' }}>
      <Card title="airouter 管理后台" style={{ width: 380 }}>
        <Form<LoginFormValues> layout="vertical" onFinish={onSubmit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
