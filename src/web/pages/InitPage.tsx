// 初始化页：首次部署设置管理员用户名与密码
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Button, Card, Form, Input, message } from 'antd'
import { getStatus, init } from '../api'

/** 初始化表单值 */
interface InitFormValues {
  /** 管理员用户名 */
  username: string
  /** 管理员密码 */
  password: string
  /** 确认密码 */
  confirm: string
}

/**
 * 初始化页组件：已初始化时自动跳登录页
 */
export default function InitPage() {
  const navigate = useNavigate()
  /** 页面状态：检查中 / 未初始化 / 已初始化 */
  const [state, setState] = useState<'loading' | 'fresh' | 'done'>('loading')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getStatus()
      .then((st) => setState(st.initialized ? 'done' : 'fresh'))
      .catch(() => setState('fresh'))
  }, [])

  if (state === 'loading') return null
  if (state === 'done') return <Navigate to="/login" replace />

  /** 提交初始化 */
  const onSubmit = async (values: InitFormValues) => {
    setSubmitting(true)
    try {
      await init(values.username, values.password)
      message.success('初始化成功，请登录')
      navigate('/login')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f5f5f5' }}>
      <Card title="初始化管理员" style={{ width: 380 }}>
        <Form<InitFormValues> layout="vertical" onFinish={onSubmit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }, { max: 64, message: '最长 64 字符' }]}>
            <Input placeholder="管理员用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '至少 6 位' }]}>
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) return Promise.resolve()
                  return Promise.reject(new Error('两次密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再输一次" autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            完成初始化
          </Button>
        </Form>
      </Card>
    </div>
  )
}
