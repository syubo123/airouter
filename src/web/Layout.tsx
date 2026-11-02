// 后台布局：侧边菜单 + 内容区（子路由出口）+ 顶栏退出
import { useNavigate, Outlet } from 'react-router-dom'
import { Button, Layout as AntLayout, Menu, message } from 'antd'
import {
  AppstoreOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  KeyOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import { logout } from './api'

/** 侧边菜单项定义 */
const MENU_ITEMS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/channels', icon: <AppstoreOutlined />, label: '渠道' },
  { key: '/keys', icon: <KeyOutlined />, label: '密钥' },
  { key: '/logs', icon: <DisconnectOutlined />, label: '失败日志' },
]

/**
 * 后台主布局组件
 */
export default function Layout() {
  const navigate = useNavigate()

  /** 退出登录 */
  const onLogout = async () => {
    try {
      await logout()
    } catch {
      // 会话已失效也直接回登录页
    }
    message.success('已退出')
    navigate('/login')
  }

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <AntLayout.Sider theme="dark" width={200}>
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 600, padding: '20px 24px' }}>airouter</div>
        <Menu
          theme="dark"
          mode="inline"
          defaultSelectedKeys={[location.pathname]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </AntLayout.Sider>
      <AntLayout>
        <AntLayout.Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingInline: 24,
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Button icon={<LogoutOutlined />} onClick={onLogout}>
            退出
          </Button>
        </AntLayout.Header>
        <AntLayout.Content style={{ padding: 24 }}>
          <Outlet />
        </AntLayout.Content>
      </AntLayout>
    </AntLayout>
  )
}
