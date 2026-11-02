// 根组件：路由表与 AntD 全局配置
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RequireAuth } from './auth'
import Layout from './Layout'
import DashboardPage from './pages/DashboardPage'
import InitPage from './pages/InitPage'
import LoginPage from './pages/LoginPage'
import ChannelsPage from './pages/ChannelsPage'
import KeysPage from './pages/KeysPage'
import LogsPage from './pages/LogsPage'

/**
 * 应用根组件：挂载路由、中文语言包与 App 上下文（message/modal）
 */
export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <BrowserRouter>
          <Routes>
            <Route path="/init" element={<InitPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="channels" element={<ChannelsPage />} />
              <Route path="keys" element={<KeysPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}
